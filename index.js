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
    /** @type {Record<string, Record<string, Record<string, string>>>} groupId -> avatar -> apiId -> presetName */
    groups: {},
};

let restoreSnapshot = null;
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

function getApiId() {
    return main_api === 'koboldhorde' ? 'kobold' : main_api;
}

function getCurrentGroup() {
    return selected_group ? groups.find(x => x.id === selected_group) : null;
}

function getManager() {
    const apiId = getApiId();
    return apiId ? getPresetManager(apiId) : null;
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

    if (Object.keys(settings.groups[groupId][avatar]).length === 0) {
        delete settings.groups[groupId][avatar];
    }
    if (Object.keys(settings.groups[groupId]).length === 0) {
        delete settings.groups[groupId];
    }

    saveSettingsDebounced();
}

function getCharacterFromMemberElement(memberElement) {
    const chid = Number(memberElement.attr('data-chid'));
    return Number.isInteger(chid) ? characters[chid] : null;
}

function createPresetSelect(group, character) {
    const manager = getManager();
    const select = $('<select class="text_pole textarea_compact group_member_preset_select"></select>')
        .attr('title', 'AI Response Configuration preset for this group member')
        .attr('data-avatar', character.avatar);

    select.append($('<option></option>', { value: '', text: 'Preset: current' }));

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

    select.on('click', event => event.stopPropagation());
    select.on('change', function (event) {
        event.stopPropagation();
        setMemberPreset(group.id, character.avatar, String($(this).val() || ''));
    });

    return select;
}

function decorateGroupMember(memberElement, group) {
    if (memberElement.find('.group_member_preset_select').length) {
        return;
    }

    const character = getCharacterFromMemberElement(memberElement);
    if (!character) {
        return;
    }

    const iconBlock = memberElement.find('.group_member_icon').first();
    if (!iconBlock.length) {
        return;
    }

    const select = createPresetSelect(group, character);
    const anchor = iconBlock.find('[data-action="enable"]').first();
    if (anchor.length) {
        anchor.after(select);
    } else {
        iconBlock.prepend(select);
    }
}

function decorateGroupMembers() {
    if (isApplyingPreset) {
        return;
    }

    const group = getCurrentGroup();
    if (!group) {
        return;
    }

    $('.rm_group_members .group_member').each(function () {
        decorateGroupMember($(this), group);
    });
}

function getPresetSnapshot() {
    const manager = getManager();
    if (!manager) {
        return null;
    }

    return {
        apiId: getApiId(),
        presetValue: manager.getSelectedPreset(),
    };
}

function selectPresetByName(presetName) {
    if (!presetName) return;

    const manager = getManager();
    if (!manager) return;

    const value = manager.findPreset(presetName);
    if (value === undefined || value === null) {
        console.warn(`[${MODULE_NAME}] AI response preset not found for ${getApiId()}: ${presetName}`);
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
    restoreSnapshot = getPresetSnapshot();
}

async function onGroupMemberDrafted(chId) {
    if (!selected_group) return;

    const character = characters[chId];
    if (!character) return;

    if (!restoreSnapshot) {
        restoreSnapshot = getPresetSnapshot();
    }

    const presetName = getSettings().groups?.[selected_group]?.[character.avatar]?.[getApiId()];
    selectPresetByName(presetName);
}

async function onGroupWrapperFinished() {
    if (!restoreSnapshot) return;

    const snapshot = restoreSnapshot;
    restoreSnapshot = null;

    const manager = getManager();
    if (!manager || snapshot.apiId !== getApiId()) {
        return;
    }

    isApplyingPreset = true;
    try {
        manager.selectPreset(snapshot.presetValue);
    } finally {
        isApplyingPreset = false;
    }
}

function observeMemberList() {
    memberListObserver?.disconnect();
    const target = document.querySelector('#rm_group_members');
    if (!target) {
        return;
    }

    memberListObserver = new MutationObserver(() => decorateGroupMembers());
    memberListObserver.observe(target, { childList: true, subtree: true });
}

export async function init() {
    getSettings();
    observeMemberList();
    decorateGroupMembers();

    eventSource.on('groupSelected', decorateGroupMembers);
    eventSource.on(event_types.CHAT_CHANGED, decorateGroupMembers);
    eventSource.on(event_types.GROUP_UPDATED, decorateGroupMembers);
    eventSource.on(event_types.SETTINGS_UPDATED, decorateGroupMembers);
    eventSource.on(event_types.GROUP_WRAPPER_STARTED, onGroupWrapperStarted);
    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
    eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
}
