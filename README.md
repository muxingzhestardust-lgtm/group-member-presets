# Group Member Presets

SillyTavern extension that allows each member in a group chat to use separate generation presets.

## Features

- Switches presets before each drafted group member generates a reply.
- Restores the original presets when the group generation finishes.
- Supports the active main API preset and advanced formatting presets:
  - Context
  - Instruct
  - System Prompt
  - Reasoning
- Stores configuration in `extension_settings.groupMemberPresets`.

## Installation

Install this folder as a SillyTavern extension, or place it under:

```text
public/scripts/extensions/group-member-presets
```

Then restart or refresh SillyTavern.

## Usage

1. Open `Extensions`.
2. Open `Group Member Presets`.
3. Enable `Enable per-member presets in group chats`.
4. Open a group chat.
5. Assign presets for each group member.
6. Generate group replies normally.

Empty preset selections keep the currently active preset.
