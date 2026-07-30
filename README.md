# Javelin Paper Tape

A VS Code extension that shows a live paper tape (stroke-by-stroke steno output) for
a connected Javelin keyboard, built on top of `JavelinHidDevice`.

## Usage

Click the Javelin icon in the activity bar to see the connection status and a
**Show Paper Tape** button, or run the **Javelin: Show Paper Tape** command from the
Command Palette directly. Strokes appear live as `outline / translation` rows as
they're received from the device.

Type in the filter box at the top of the paper tape to search by outline or
translation. Strokes are always recorded to the tape **except while the filter box is
focused** — click or tab away
```bash
npm install
```

Press **F5** (or Run → Start Debugging) to launch an Extension Development Host with
the extension loaded. This runs the `npm: compile` task first, then opens a new VS Code
window — run the **Javelin: Show Paper Tape** command there to try it out. Use
`npm run watch` to recompile on save while debugging.
