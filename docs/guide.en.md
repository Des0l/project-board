# Project Board user guide

[Repository overview](../README.en.md) · [Русское руководство](guide.ru.md)

**From chat to card**

> Add task: Check the museum hours. The Saturday itinerary needs the time of last admission.

When the board syncs, the task appears in **Inbox**. Choose **Add to board** to create a card.

| Card field | Example |
| --- | --- |
| Title | Check the museum hours |
| Description | The Saturday itinerary needs the time of last admission. |
| Project | Atlas |
| Starting column | Planned |

Project Board is available in English and Russian. It follows your browser or system language by default and uses English when neither supported language is listed. Open **Board and project settings** next to the project list and choose **Interface language**. The board remembers your selection on this device.

The board looks for tasks in English and Russian. It keeps excerpts in the language of the chat. If a chat contains only a task title, the card's description stays empty.

## Download and run

Download the [latest release](https://github.com/Des0l/project-board/releases/latest) for your system and extract it to a folder you can write to. Choose `x64` for Intel or AMD, or `arm64` for Apple Silicon and other ARM processors. Node.js and SQLite are included.

| Platform | Launch |
| --- | --- |
| Windows | Double-click `ProjectBoard.exe`. |
| macOS | Open `Open-board.command`, or run `sh Open-board.sh` in Terminal. |
| Linux | Run `sh Open-board.sh` in the extracted folder. |

For a source install, use Node.js 22.13 or later and run `npm run open` from the repository.

## Connect a project

To read your Codex chats, the board needs the local Codex CLI on your PATH and the folders where those chats took place. Create `projects.local.json` in the board's data directory and list the absolute paths to your project folders. The default path is `data/projects.local.json`. Then start the board.

```json
{
  "projects": [
    { "id": "atlas", "name": "Atlas", "roots": ["/absolute/path/to/atlas"] }
  ]
}
```

On Windows, use paths such as `D:/Projects/atlas`. The board checks connected chats when you open it or click **Refresh board**. In **Inbox**, choose a column and accept the suggestion, or skip it. For a card you already have, open **Description drafts** to review the text before saving it.

## Connect another assistant

The board checks Codex history automatically. Claude Code, Kimi and other assistants can send tasks through the command that comes with the board or through the local HTTP API.

To connect another assistant, open the project's settings and expand **Connect another assistant**. Copy the instructions into a chat that can run commands on your computer. The instructions use the board's current language. See the [agent instructions](../skills/project-board/SKILL.md) for how to send the task details with `--description`.

## Project Board in the ChatGPT app

The ChatGPT app for your computer includes a Codex mode. To use Project Board from a Codex chat, install the local Project Board plugin. You need the `codex` command on your PATH. On Windows, run `Connect-ChatGPT.cmd`. On macOS and Linux, run `sh Open-board.sh --install-plugin` from the board's folder. This connects the plugin to this copy of the board and its database. If you move the app, install the plugin again.

In the ChatGPT app, switch to Codex and select the Project Board plugin. You can ask it to list projects or cards, create a task, or update a card. If the board server is stopped, the plugin starts it on demand. [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt)

## Data and backups

The board uses SQLite on your computer to store cards, projects, saved excerpts, links and inbox decisions. The server listens on `127.0.0.1`. Programs that can reach that port can access the board. To back up your data, open **Sources** and choose **Save backup**.

The [Russian manual](guide.ru.md) covers project filters, cards linked to multiple chats, desktop ChatGPT and restoring a backup. The code is available under the [MIT license](../LICENSE).
