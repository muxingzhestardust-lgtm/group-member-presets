# Group Member Response Presets

SillyTavern extension that allows each member in a group chat to use a separate AI Response Configuration preset.

## Features

- Adds an AI Response Configuration preset dropdown next to each group member's mute/unmute controls.
- Switches the active main API response preset before each drafted group member generates a reply.
- Restores the original presets when the group generation finishes.
- Adds Director Mode controls to the group chat controls panel.
- Adds Role and Narration category tabs with multi-select member assignment.
- Analyzes the latest user input to select and order acting Role characters.
- Generates confirmed Role actions in order, then lets Narration characters respond after the next user instruction.
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

## Director Mode

1. Open a group chat and enable `Director Mode` in Group Controls.
2. Use the `Role` and `Narration` tabs to classify members. Members can be selected in both categories.
3. Send or type a user instruction.
4. Click `Analyze Action` to ask the active API which Role characters should act and in what order.
5. Review the automatically unmuted actors. Adjust manually if needed.
6. Click `Confirm Action` to generate Role character replies in order.
7. Send the next user instruction normally. Director Mode will mute Role characters, allow Narration characters to speak, then hide the previous Role action messages.

Use `Analysis Prompt` to edit the analysis prompt. Supported macros are `{{characters}}` and `{{input}}`.
