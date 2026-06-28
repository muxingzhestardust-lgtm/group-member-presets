import {
    characters,
    eventSource,
    event_types,
    main_api,
    saveSettingsDebounced,
} from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { getPresetManager } from '/scripts/preset-manager.js';
import { groups, selected_group } from '/scripts/group-chats.js';

export { MODULE_NAME };

const MODULE_NAME = 'groupMemberPresets';

const defaultSettings = {
    enabled: false,
    /** @type {Record<string, Record<string, Record<string, string>>>} groupId -> avatar -> apiId -> presetName */
    groups: {},
};

const managedPresetTypes = ['api', 'context', 'instruct', 'sysprompt', 'reasoning'];
let restoreSnapshot = null;
let isApplyingPreset = false;

async function renderSettingsTemplate() {
    const response = await fetch(new URL('settings.html', import.meta.url));
    if (!response.ok) {
        throw new Error(`Could not load settings template: ${response.status}`);
    }
    return response.text();
}

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

function getCurrentGroup() {
    return selected_group ? groups.find(x => x.id === selected_group) : null;
}

function getApiId(type) {
    return type === 'api' ? main_api : type;
}

function getStorageKey(type) {
    return type === 'api' ? main_api : type;
}

function getManager(type) {
    const apiId = getApiId(type);
    return apiId ? getPresetManager(apiId) : null;
}

function getPresetNames(type) {
    const manager = getManager(type);
    return manager ? manager.getAllPresets() : [];
}

function getMemberPreset(groupId, avatar, type) {
    return getSettings().groups?.[groupId]?.[avatar]?.[getStorageKey(type)] || '';
}

function setMemberPreset(groupId, avatar, type, presetName) {
    const settings = getSettings();
    settings.groups[groupId] ??= {};
    settings.groups[groupId][avatar] ??= {};

    const storageKey = getStorageKey(type);

    if (presetName) {
        settings.groups[groupId][avatar][storageKey] = presetName;
    } else {
        delete settings.groups[groupId][avatar][storageKey];
    }

    if (Object.keys(settings.groups[groupId][avatar]).length === 0) {
        delete settings.groups[groupId][avatar];
    }
    if (Object.keys(settings.groups[groupId]).length === 0) {
        delete settings.groups[groupId];
    }

    saveSettingsDebounced();
}

function createPresetSelect(group, character, type) {
    const select = $('<select class="text_pole flex1"></select>')
        .attr('data-avatar', character.avatar)
        .attr('data-preset-type', type);

    select.append($('<option></option>', { value: '', text: 'Use current' }));

    const selectedName = getMemberPreset(group.id, character.avatar, type);
    for (const presetName of getPresetNames(type)) {
        select.append($('<option></option>', {
            value: presetName,
            text: presetName,
            selected: presetName === selectedName,
        }));
    }

    select.on('change', function () {
        setMemberPreset(group.id, character.avatar, type, String($(this).val() || ''));
    });

    return select;
}

function renderMembers() {
    const settings = getSettings();
    $('#group_member_presets_enabled').prop('checked', !!settings.enabled);

    const container = $('#group_member_presets_members');
    const status = $('#group_member_presets_status');
    container.empty();

    const group = getCurrentGroup();
    if (!group) {
        status.text('Open a group chat to configure per-member presets.');
        return;
    }

    const members = group.members
        .map(avatar => characters.find(character => character.avatar === avatar))
        .filter(Boolean);

    if (!members.length) {
        status.text('This group has no available members.');
        return;
    }

    status.text(`Configuring ${members.length} member(s) for group: ${group.name}`);

    for (const character of members) {
        const block = $('<div class="list-group-item flex-container flexFlowColumn flexGap5"></div>');
        block.append($('<b></b>').text(character.name));

        for (const type of managedPresetTypes) {
            const manager = getManager(type);
            const apiId = getApiId(type);
            const row = $('<label class="flex-container alignitemscenter flexGap5"></label>');
            row.append($('<span class="width100px"></span>').text(type === 'api' ? `API (${apiId || 'none'})` : type));

            if (!manager) {
                row.append($('<small class="opacity50p"></small>').text('Preset manager unavailable'));
            } else {
                row.append(createPresetSelect(group, character, type));
            }

            block.append(row);
        }

        container.append(block);
    }
}

function getPresetSnapshot() {
    const snapshot = {};
    for (const type of managedPresetTypes) {
        const manager = getManager(type);
        if (!manager) continue;

        snapshot[type] = {
            apiId: getApiId(type),
            presetName: manager.getSelectedPresetName(),
            presetValue: manager.getSelectedPreset(),
        };
    }
    return snapshot;
}

function selectPresetByName(type, presetName) {
    if (!presetName) return;

    const manager = getManager(type);
    if (!manager) return;

    const value = manager.findPreset(presetName);
    if (value === undefined || value === null) {
        console.warn(`[${MODULE_NAME}] Preset not found for ${getApiId(type)}: ${presetName}`);
        return;
    }

    if (manager.getSelectedPresetName() === presetName) {
        return;
    }

    isApplyingPreset = true;
    try {
        manager.selectPreset(value);
    } finally {
        isApplyingPreset = false;
    }
}

async function onGroupWrapperStarted() {
    if (!getSettings().enabled) return;
    restoreSnapshot = getPresetSnapshot();
}

async function onGroupMemberDrafted(chId) {
    const settings = getSettings();
    if (!settings.enabled || !selected_group) return;

    const character = characters[chId];
    if (!character) return;

    if (!restoreSnapshot) {
        restoreSnapshot = getPresetSnapshot();
    }

    const memberSettings = settings.groups?.[selected_group]?.[character.avatar];
    if (!memberSettings) return;

    for (const type of managedPresetTypes) {
        selectPresetByName(type, memberSettings[getStorageKey(type)]);
    }
}

async function onGroupWrapperFinished() {
    if (!restoreSnapshot) return;

    const snapshot = restoreSnapshot;
    restoreSnapshot = null;

    for (const type of managedPresetTypes) {
        const item = snapshot[type];
        if (!item) continue;

        const manager = getManager(type);
        if (!manager || item.apiId !== getApiId(type)) continue;

        isApplyingPreset = true;
        try {
            manager.selectPreset(item.presetValue);
        } finally {
            isApplyingPreset = false;
        }
    }
}

function onSettingsChanged() {
    if (!isApplyingPreset) {
        renderMembers();
    }
}

export async function init() {
    const settingsHtml = await renderSettingsTemplate();
    $('#extensions_settings2').append(settingsHtml);

    getSettings();
    renderMembers();

    $('#group_member_presets_enabled').on('input', function () {
        getSettings().enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#group_member_presets_refresh').on('click', renderMembers);

    eventSource.on(event_types.CHAT_CHANGED, renderMembers);
    eventSource.on(event_types.GROUP_UPDATED, renderMembers);
    eventSource.on(event_types.SETTINGS_UPDATED, onSettingsChanged);
    eventSource.on(event_types.GROUP_WRAPPER_STARTED, onGroupWrapperStarted);
    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
    eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
}
