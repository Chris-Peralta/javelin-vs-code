# Javelin Paper Tape

A VS Code extension that shows a live paper tape for
a connected [Javelin](https://github.com/jthlim/javelin-steno) keyboard.

![Paper tape preview](images/preview.png)

## Installation

This extension isn't published to the VS Code Marketplace. Download the `.vsix` file matching
your OS and CPU from the [Releases page](https://github.com/Chris-Peralta/javelin-vs-code/releases):

| File | Platform |
| --- | --- |
| `javelin-paper-tape-<version>-win32-x64.vsix` | Windows (64-bit) |
| `javelin-paper-tape-<version>-darwin-x64.vsix` | macOS (Intel) |
| `javelin-paper-tape-<version>-darwin-arm64.vsix` | macOS (Apple Silicon) |
| `javelin-paper-tape-<version>-linux-x64.vsix` | Linux (64-bit) |
| `javelin-paper-tape-<version>-linux-arm64.vsix` | Linux (ARM64) |

Then in VS Code:
- Open the Command Palette (Ctrl or Cmd + Shift + P)
- Select "Extensions: Install from VSIX..."
- Select the downloaded file

## Usage

Click the Javelin icon in the activity bar (left side).

**Settings**:

- **Show timestamps in paper tape** — adds a time column to each row.
- **Record paper tape while VS Code is in the background** — keeps recording strokes
  even when the window isn't focused.
- **Save a separate paper tape per window** — persists the tape so it survives
  closing and reopening the window.

The last two are mutually exclusive.

## Development

```bash
npm install
```

Press **F5** (or Run → Start Debugging) to launch an Extension Development Host with
the extension loaded. This runs the `npm: compile` task first, then opens a new VS Code
window — run the **Javelin: Show Paper Tape** command there to try it out. Use
`npm run watch` to recompile on save while debugging.

# Contributions

- [Javelin](https://github.com/jthlim/javelin-steno) - [jthlim](https://github.com/jthlim/)
- [Javelin WebHID library](https://github.com/ServerBBQ/javelin-webtools/blob/main/lib/javelinHidDevice.ts) - [ServerBBQ](https://github.com/ServerBBQ/)
