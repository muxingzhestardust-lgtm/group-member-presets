# Group Member Response Presets

SillyTavern extension that lets each member in a group chat use its own AI Response Configuration preset instead of the single global preset.

## Features

- Adds an AI Response Configuration preset dropdown next to each group member in the group control panel.
- Switches the active main API response preset before each drafted group member generates a reply.
- Restores the original global preset after the group generation finishes.
- Members left on `(global)` keep the currently selected preset.
- Presets are stored per API (OpenAI/chat completion, text completion, etc.).
- An on/off toggle is added to the Extensions settings panel.
- Stores configuration in `extension_settings.groupPresetPerMember`.

## Installation

Install via SillyTavern's extension installer using this repository URL, or place this folder under:

```text
public/scripts/extensions/third-party/group-member-presets
```

Then restart or refresh SillyTavern.

## Usage

1. Open a group chat.
2. Open `Group Controls`.
3. In `Current Members`, use the preset dropdown next to each member.
4. Generate group replies normally.

Empty (`(global)`) selections keep the currently active preset.
