# Group Member Response Presets

SillyTavern extension that allows each member in a group chat to use a separate AI Response Configuration preset.

## Features

- Adds an AI Response Configuration preset dropdown next to each group member's mute/unmute controls.
- Switches the active main API response preset before each drafted group member generates a reply.
- Restores the original presets when the group generation finishes.
- Stores configuration in `extension_settings.groupMemberPresets`.

## Installation

Install this folder as a SillyTavern extension, or place it under:

```text
public/scripts/extensions/group-member-presets
```

Then restart or refresh SillyTavern.

## Usage

1. Open a group chat.
2. Open `Group Controls`.
3. In `Current Members`, use the preset dropdown next to each member's mute/unmute controls.
4. Generate group replies normally.

Empty preset selections keep the currently active preset.
