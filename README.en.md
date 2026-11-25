# Project Board

[Русский](README.md)

Project Board finds tasks in local Codex conversations and brings them together across projects. Each card can keep the relevant details and a link back to the conversation.

**From chat to card**

> Add task: Check the museum hours. The Saturday itinerary needs the time of last admission.

When the board syncs, this request appears in the inbox. Choose **Добавить на доску** (Add to board) to create the card.

| Card field | Example |
| --- | --- |
| Title | Check the museum hours |
| Description | The Saturday itinerary needs the time of last admission. |
| Project | Atlas |
| Starting column | Planned |

The interface is in Russian. Task detection supports English and Russian, and excerpts keep their original wording. When a chat contains only a title, the description stays empty.

## Download and run

Download and extract the [latest release](https://github.com/Des0l/project-board/releases/latest) into a writable folder. Choose `x64` for Intel or AMD, or `arm64` for Apple Silicon and other ARM64 devices. The archives include Node.js and SQLite.

| Platform | Launch |
| --- | --- |
| Windows | Double-click `ProjectBoard.exe`. |
| macOS | Open `Open-board.command`, or run `sh Open-board.sh` in Terminal. |
| Linux | Run `sh Open-board.sh` in the extracted folder. |

To run from source, install Node.js 22.13 or later and run `npm run open` in the repository.

## Connect a project

To read a Codex conversation, the board needs the local Codex CLI in your PATH and the project folder where the conversation took place. To configure project folders, create `data/projects.local.json` in the board's data directory with your own absolute paths, then start the board.

```json
{
  "projects": [
    { "id": "atlas", "name": "Atlas", "roots": ["/absolute/path/to/atlas"] }
  ]
}
```

On Windows, a path can look like `D:/Projects/atlas`. Opening the board or clicking **Обновить доску** (Refresh board) checks the connected history. In **Неразобранные задачи** (Inbox), you can accept a suggestion, pick a column, or skip it. For existing cards, **Черновики описаний** (Description drafts) lets you review the text before saving it.

Other assistants can submit individual tasks through the bundled command or local HTTP API. The [agent instructions](skills/project-board/SKILL.md) explain how to include the source conversation's details with `--description`.

## Data and backups

Each installation creates its own SQLite board. It stores cards, projects, selected excerpts, links and review decisions. The board listens on the local loopback interface. Other programs running as your user can access this local service. To back up your board, open **Источники** (Sources) and choose **Сохранить копию** (Save a copy).

The [Russian manual](README.md) also covers project filters, multi-chat cards, desktop ChatGPT integration and restoring a backup. The source code is available under the [MIT license](LICENSE).
