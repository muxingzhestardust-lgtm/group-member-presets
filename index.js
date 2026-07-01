import {
    characters,
    eventSource,
    event_types,
    main_api,
    saveSettingsDebounced,
} from '/script.js';
import { extension_settings, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { getPresetManager } from '/scripts/preset-manager.js';
import { groups, selected_group } from '/scripts/group-chats.js';

const MODULE_NAME = 'groupPresetPerMember';
const EXTENSION_PATH = 'third-party/group-member-presets';

/**
 * Settings shape:
 * {
 *   enabled: boolean,
 *   // groupId -> avatar -> apiId -> presetName
 *   groups: Record<string, Record<string, Record<string, string>>>
 * }
 */
const defaultSettings = {
    enabled: true,
    groups: {},
};

// Snapshot of the globally-selected preset, taken before a group generation
// starts, so we can restore it after all members have finished.
let restorePresetSnapshot = null;
// Guard so our own preset switching / DOM injection doesn't recurse via events.
let isApplyingPreset = false;
let memberListObserver = null;

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = structuredClone(value);
        }
    }
    return extension_settings[MODULE_NAME];
}

// The preset system is keyed per-API. Store a preset per API so switching the
// active API keeps sane per-member choices.
function getApiId() {
    return main_api === 'koboldhorde' ? 'kobold' : main_api;
}

function getManager() {
    const apiId = getApiId();
    return apiId ? getPresetManager(apiId) : null;
}

function getCurrentGroup() {
    return selected_group ? groups.find(x => x.id === selected_group) : null;
}

function getMemberPreset(groupId, avatar) {
    return getSettings().groups?.[groupId]?.[avatar]?.[getApiId()] || '';
}

function setMemberPreset(groupId, avatar, presetName) {
    const settings = getSettings();
    const apiId = getApiId();

    settings.groups[groupId] ??= {};
    settings.groups[groupId][avatar] ??= {};

    if (presetName) {
        settings.groups[groupId][avatar][apiId] = presetName;
    } else {
        delete settings.groups[groupId][avatar][apiId];
    }

    // Clean up empty branches.
    if (Object.keys(settings.groups[groupId][avatar]).length === 0) {
        delete settings.groups[groupId][avatar];
    }
    if (Object.keys(settings.groups[groupId] ?? {}).length === 0) {
        delete settings.groups[groupId];
    }

    saveSettingsDebounced();
}

function getCharacterFromMemberElement(memberElement) {
    const chid = Number(memberElement.attr('data-chid'));
    return Number.isInteger(chid) ? characters[chid] : null;
}

// ---------------------------------------------------------------------------
// UI: inject a preset <select> next to every member row in the group panel.
// ---------------------------------------------------------------------------

function createPresetSelect(group, character) {
    const manager = getManager();
    const select = $('<select class="text_pole textarea_compact group_ppm_preset_select"></select>')
        .attr('title', 'AI Response Configuration preset used when this member replies. Empty = use the globally selected preset.')
        .attr('data-avatar', character.avatar);

    select.append($('<option></option>', { value: '', text: 'Preset: (global)' }));

    if (!manager) {
        select.prop('disabled', true);
        return select;
    }

    const selectedName = getMemberPreset(group.id, character.avatar);
    for (const presetName of manager.getAllPresets()) {
        select.append($('<option></option>', {
            value: presetName,
            text: presetName,
            selected: presetName === selectedName,
        }));
    }

    // Prevent the row's own click handlers (which toggle member state) from firing.
    select.on('click', event => event.stopPropagation());
    select.on('change', function (event) {
        event.stopPropagation();
        setMemberPreset(group.id, character.avatar, String($(this).val() || ''));
    });

    return select;
}

function decorateGroupMember(memberElement, group) {
    if (memberElement.find('.group_ppm_preset_select').length) {
        return;
    }
    const character = getCharacterFromMemberElement(memberElement);
    if (!character) return;

    const iconBlock = memberElement.find('.group_member_icon').first();
    if (!iconBlock.length) return;

    const select = createPresetSelect(group, character);
    // Insert before the action buttons so it sits at the start of the row's controls.
    iconBlock.prepend(select);
}

function decorateGroupMembers() {
    if (isApplyingPreset) return;
    if (!getSettings().enabled) return;

    const group = getCurrentGroup();
    if (!group) return;

    $('.rm_group_members .group_member').each(function () {
        decorateGroupMember($(this), group);
    });
}

function removeDecorations() {
    $('.group_ppm_preset_select').remove();
}

function refreshDecorations() {
    removeDecorations();
    decorateGroupMembers();
}

// Re-decorate whenever the core re-renders the member list (pagination,
// reorder, enable/disable, etc.).
function observeMemberList() {
    memberListObserver?.disconnect();
    const target = document.querySelector('#rm_group_members');
    if (!target) return;

    memberListObserver = new MutationObserver(() => decorateGroupMembers());
    memberListObserver.observe(target, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Generation hooks: swap preset before each member, restore afterwards.
// ---------------------------------------------------------------------------

function getPresetSnapshot() {
    const manager = getManager();
    if (!manager) return null;
    return { apiId: getApiId(), presetValue: manager.getSelectedPreset() };
}

function selectPresetByName(presetName) {
    if (!presetName) return;
    const manager = getManager();
    if (!manager) return;

    const value = manager.findPreset(presetName);
    if (value === undefined || value === null) {
        console.warn(`[${MODULE_NAME}] Preset not found for ${getApiId()}: ${presetName}`);
        return;
    }
    if (manager.getSelectedPresetName() === presetName) return;

    isApplyingPreset = true;
    try {
        manager.selectPreset(value);
    } finally {
        isApplyingPreset = false;
    }
}

function onGroupWrapperStarted() {
    if (!getSettings().enabled) return;
    restorePresetSnapshot = getPresetSnapshot();
}

function onGroupMemberDrafted(chId) {
    if (!getSettings().enabled) return;
    if (!selected_group) return;

    const character = characters[chId];
    if (!character) return;

    // Snapshot lazily in case the wrapper-started event was missed.
    if (!restorePresetSnapshot) restorePresetSnapshot = getPresetSnapshot();

    const presetName = getMemberPreset(selected_group, character.avatar);
    selectPresetByName(presetName);
}

function onGroupWrapperFinished() {
    if (!restorePresetSnapshot) return;

    const manager = getManager();
    if (manager && restorePresetSnapshot.apiId === getApiId()) {
        isApplyingPreset = true;
        try {
            manager.selectPreset(restorePresetSnapshot.presetValue);
        } finally {
            isApplyingPreset = false;
        }
    }
    restorePresetSnapshot = null;
}

// ---------------------------------------------------------------------------
// Settings panel.
// ---------------------------------------------------------------------------

function bindSettingsUi() {
    const enabled = getSettings().enabled;
    $('#group_ppm_enabled').prop('checked', enabled);

    $('#group_ppm_enabled').on('change', function () {
        getSettings().enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        refreshDecorations();
    });
}

export async function init() {
    getSettings();

    try {
        const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
        $('#extensions_settings2').append(settingsHtml);
        bindSettingsUi();
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to render settings`, error);
    }

    observeMemberList();
    decorateGroupMembers();

    // Group panel opened / chat switched: the member DOM is (re)built.
    eventSource.on('groupSelected', () => { observeMemberList(); refreshDecorations(); });
    eventSource.on(event_types.CHAT_CHANGED, refreshDecorations);
    eventSource.on(event_types.GROUP_UPDATED, decorateGroupMembers);

    // Per-member preset apply / restore around group generation.
    eventSource.on(event_types.GROUP_WRAPPER_STARTED, onGroupWrapperStarted);
    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
    eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
}
