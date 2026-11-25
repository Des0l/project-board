using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class ProjectBoard {
    internal static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;

    internal static Uri StartServer() {
        string runtime = Path.Combine(Root, "runtime", "node.exe");
        var start = new ProcessStartInfo {
            FileName = File.Exists(runtime) ? runtime : "node.exe",
            WorkingDirectory = Root,
            Arguments = "\"" + Path.Combine(Root, "open-board.mjs") + "\" --no-open",
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardError = true, RedirectStandardOutput = true,
            StandardErrorEncoding = Encoding.UTF8, StandardOutputEncoding = Encoding.UTF8
        };
        using (var child = Process.Start(start)) {
            var errors = child.StandardError.ReadToEndAsync();
            string address = child.StandardOutput.ReadToEnd().Trim();
            child.WaitForExit();
            if (child.ExitCode != 0) throw new InvalidOperationException(errors.Result.Trim());
            Uri url;
            if (!Uri.TryCreate(address, UriKind.Absolute, out url) ||
                url.Scheme != "http" || url.Host != "127.0.0.1") {
                throw new InvalidOperationException("Сервер не вернул локальный адрес доски.");
            }
            return url;
        }
    }

    [STAThread]
    private static int Main(string[] args) {
        bool headless = args.Length == 1 && args[0] == "--no-open";
        try {
            if (args.Length > 0 && !headless) throw new ArgumentException("Допустимый параметр: --no-open");
            if (headless) { StartServer(); return 0; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var window = new BoardWindow()) Application.Run(window);
            return 0;
        } catch (Exception error) {
            if (!headless) MessageBox.Show(error.Message, "Доска проектов", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}

internal sealed class BoardWindow : Form {
    private readonly Panel startup = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24) };
    private readonly Label status = new Label { Dock = DockStyle.Fill, Text = "Открываем доску…" };
    private readonly Button browser = new Button { AutoSize = true, Text = "Открыть в браузере", Enabled = false };
    private Uri address;
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    // Windows 10 supports dark captions. Windows 11 also accepts custom colors and corners.
    private void ApplyFrame() {
        if (!IsHandleCreated) return;
        bool system = SystemInformation.HighContrast;
        int dark = system ? 0 : 1;
        int caption = system ? -1 : ColorTranslator.ToWin32(Color.FromArgb(28, 41, 42));
        int text = system ? -1 : ColorTranslator.ToWin32(Color.WhiteSmoke);
        int corners = system ? 0 : 2;
        try {
            if (DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int)) != 0)
                DwmSetWindowAttribute(Handle, 19, ref dark, sizeof(int));
            DwmSetWindowAttribute(Handle, 35, ref caption, sizeof(int));
            DwmSetWindowAttribute(Handle, 36, ref text, sizeof(int));
            DwmSetWindowAttribute(Handle, 33, ref corners, sizeof(int));
        } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
    }

    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        ApplyFrame();
    }

    protected override void OnSystemColorsChanged(EventArgs e) {
        base.OnSystemColorsChanged(e);
        ApplyFrame();
    }

    internal BoardWindow() {
        Text = "Доска проектов";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        Size area = Screen.FromControl(this).WorkingArea.Size;
        ClientSize = new Size(Math.Min(1280, area.Width * 9 / 10), Math.Min(850, area.Height * 9 / 10));
        Font = SystemFonts.MessageBoxFont;
        AutoScaleMode = AutoScaleMode.Dpi;
        startup.BackColor = SystemInformation.HighContrast ? SystemColors.Window : Color.FromArgb(251, 252, 250);
        status.ForeColor = SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(28, 41, 42);
        browser.FlatStyle = FlatStyle.System;
        var actions = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true };
        actions.Controls.Add(browser);
        startup.Controls.Add(status);
        startup.Controls.Add(actions);
        Controls.Add(startup);
        browser.Click += delegate {
            try { Process.Start(new ProcessStartInfo(address.AbsoluteUri) { UseShellExecute = true }); }
            catch (Exception error) { status.Text = address.AbsoluteUri + Environment.NewLine + error.Message; }
        };
        Shown += LoadBoard;
    }

    private async void LoadBoard(object sender, EventArgs args) {
        try {
            address = await Task.Run(() => ProjectBoard.StartServer());
            if (IsDisposed) return;
            browser.Enabled = true;
            status.Text = "Загружаем " + address.AbsoluteUri;
            await OpenView();
        } catch (Exception error) {
            ShowProblem(error.Message);
        }
    }

    private async Task OpenView() {
        var view = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(view);
        startup.BringToFront();
        string profile = Path.Combine(ProjectBoard.Root, ".work", "desktop-profile", address.Port.ToString());
        var environment = await CoreWebView2Environment.CreateAsync(null, profile);
        if (IsDisposed) return;
        await view.EnsureCoreWebView2Async(environment);
        if (IsDisposed) return;
        view.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
            if (IsDisposed) return;
            if (e.IsSuccess) view.BringToFront();
            else ShowProblem("Ошибка загрузки страницы: " + e.WebErrorStatus);
        };
        view.Source = address;
    }

    private void ShowProblem(string detail) {
        if (IsDisposed) return;
        startup.BringToFront();
        status.Text = (address == null ? "Не удалось запустить доску." : "Доска доступна по адресу " + address.AbsoluteUri)
            + Environment.NewLine + detail;
    }
}
