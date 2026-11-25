"""Build offline desktop bundles. Run with Python 3.11+ and npm."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.work' / 'portable-cache'
RELEASE = ROOT / 'release'
NODE = '24.22.3'
# From https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
DIGESTS = {
    'win-x64': 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
    'win-arm64': 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14',
    'darwin-x64': '4daeec962855c1a6e66cda398a25037319dc1bbd4a0939188b3547afbbfb6490',
    'darwin-arm64': '1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5',
    'linux-x64': '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb',
    'linux-arm64': '6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c',
}


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def runtime(target):
    prefix = f'node-v{NODE}-{target}'
    windows = target.startswith('win-')
    archive = CACHE / (prefix + ('.zip' if windows else '.tar.xz'))
    if not archive.exists() or sha256(archive) != DIGESTS[target]:
        with tempfile.TemporaryDirectory(dir=CACHE) as temp:
            download = Path(temp) / archive.name
            with urllib.request.urlopen(f'https://nodejs.org/dist/v{NODE}/{archive.name}', timeout=90) as src, download.open('wb') as dst:
                shutil.copyfileobj(src, dst)
            if sha256(download) != DIGESTS[target]:
                raise ValueError(f'Checksum mismatch for {archive.name}')
            download.replace(archive)
    if windows:
        with zipfile.ZipFile(archive) as z:
            return {'runtime/node.exe': z.read(prefix+'/node.exe'), 'runtime/LICENSE': z.read(prefix+'/LICENSE')}
    with tarfile.open(archive, 'r|xz') as tar:
        wanted = {prefix+'/bin/node': 'runtime/node', prefix+'/LICENSE': 'runtime/LICENSE'}
        contents = {}
        for member in tar:
            if member.name in wanted and member.isfile():
                contents[wanted[member.name]] = tar.extractfile(member).read()
            if len(contents) == len(wanted):
                return contents
    raise ValueError(f'Incomplete Node distribution for {target}')


def build(target, files, version):
    included = dict(files)
    if target.startswith('win-'):
        del included['Open-board.command'], included['Open-board.sh']
        if (ROOT / 'ProjectBoard.exe').is_file():
            desktop_files = ['ProjectBoard.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll',
                             'runtime/webview2-LICENSE.txt', 'runtime/webview2-NOTICE.txt']
            desktop_files.extend(f'runtimes/win-{arch}/native/WebView2Loader.dll' for arch in ('x86', 'x64', 'arm64'))
            included.update({name: (ROOT / name).read_bytes() for name in desktop_files})
    else:
        del included['Open-board.cmd'], included['Connect-ChatGPT.cmd'], included['Start-board.ps1']
        if target.startswith('linux-'):
            del included['Open-board.command']
    included.update(runtime(target))
    system, arch = target.split('-')
    label = {'win': 'windows', 'darwin': 'macos', 'linux': 'linux'}[system] + '-' + arch
    linux = target.startswith('linux-')
    output = RELEASE / (f'project-board-{version}-{label}' + ('.tar.gz' if linux else '.zip'))
    with tempfile.TemporaryDirectory(dir=RELEASE) as temp:
        staged = Path(temp) / output.name
        with (tarfile.open(staged, 'w:gz', compresslevel=5) if linux else zipfile.ZipFile(staged, 'w')) as archive:
            for path, data in sorted(included.items()):
                name = 'project-board/' + path
                mode = 0o755 if path in ('runtime/node', 'Open-board.sh', 'Open-board.command') else 0o644
                if linux:
                    info = tarfile.TarInfo(name)
                    info.mode, info.size = mode, len(data)
                    archive.addfile(info, io.BytesIO(data))
                else:
                    info = zipfile.ZipInfo(name)
                    info.create_system = 3
                    info.external_attr = (0o100000 | mode) << 16
                    archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=5)
        staged.replace(output)
    print(output.name, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('targets', nargs='*', help=', '.join(DIGESTS))
    args = parser.parse_args()
    targets = args.targets or list(DIGESTS)
    if set(targets) - DIGESTS.keys():
        parser.error('Unknown target')
    if os.name == 'nt' and any(t.startswith('win-') for t in targets):
        subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                        str(ROOT/'scripts'/'build-windows-launcher.ps1')], check=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    RELEASE.mkdir(exist_ok=True)
    package = json.loads((ROOT/'package.json').read_text(encoding='utf-8'))
    listing = subprocess.check_output([shutil.which('npm.cmd') or shutil.which('npm'), 'pack', '--dry-run', '--ignore-scripts', '--json'], cwd=ROOT)
    files = {f['path']: (ROOT/f['path']).read_bytes() for f in json.loads(listing)[0]['files']}
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(partial(build, files=files, version=package['version']), dict.fromkeys(targets)))
