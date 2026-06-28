import {
    characters,
    chat,
    eventSource,
    event_types,
    Generate,
    generateRaw,
    getRequestHeaders,
    main_api,
    saveChatConditional,
    saveSettingsDebounced,
} from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { getPresetManager } from '/scripts/preset-manager.js';
import { groups, selected_group } from '/scripts/group-chats.js';
import { Popup } from '/scripts/popup.js';

export { MODULE_NAME };

const MODULE_NAME = 'groupMemberPresets';
const directorStrategyValue = 'director';

const defaultPrompt = `Analyze the user's latest input for a SillyTavern group chat.
Return JSON only in this format: {"actors":["Character Name 1","Character Name 2"]}
Include only characters that need to take action now. Sort them in the likely action order.
Available action-role characters: {{characters}}
User input: {{input}}`;

const defaultSettings = {
    /** @type {Record<string, Record<string, Record<string, string>>>} groupId -> avatar -> apiId -> presetName */
    groups: {},
    /** @type {Record<string, {roles: string[], narrators: string[], prompt: string, directorMode: boolean}>} */
    director: {},
};

let restorePresetSnapshot = null;
let disabledMembersSnapshot = null;
let isApplyingPreset = false;
let memberListObserver = null;
let suppressNextWrapperRestore = false;
let activeCategoryTab = 'roles';

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

function getDirectorSettings(groupId = selected_group) {
    const settings = getSettings();
    settings.director[groupId] ??= { roles: [], narrators: [], prompt: defaultPrompt, directorMode: false };
    settings.director[groupId].roles ??= [];
    settings.director[groupId].narrators ??= [];
    settings.director[groupId].prompt ||= defaultPrompt;
    settings.director[groupId].directorMode ??= false;
    return settings.director[groupId];
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

function getCharacterByAvatar(avatar) {
    return characters.find(character => character.avatar === avatar);
}

function getCharacterIdByAvatar(avatar) {
    return characters.findIndex(character => character.avatar === avatar);
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

function createCategoryCheckbox(group, character, type) {
    const director = getDirectorSettings(group.id);
    const list = type === 'role' ? director.roles : director.narrators;
    const label = $('<label class="checkbox_label group_member_director_checkbox"></label>')
        .attr('title', type === 'role' ? 'Role category: can be selected by action analysis' : 'Narration category: can speak after the next user instruction');
    const checkbox = $('<input type="checkbox" />')
        .prop('checked', list.includes(character.avatar))
        .on('click', event => event.stopPropagation())
        .on('change', function (event) {
            event.stopPropagation();
            const targetList = type === 'role' ? director.roles : director.narrators;
            const index = targetList.indexOf(character.avatar);
            if ($(this).prop('checked') && index === -1) {
                targetList.push(character.avatar);
            } else if (!$(this).prop('checked') && index !== -1) {
                targetList.splice(index, 1);
            }
            saveSettingsDebounced();
        });
    label.append(checkbox, $('<small></small>').text(type === 'role' ? 'Role' : 'Narration'));
    return label;
}

function decorateGroupMember(memberElement, group) {
    const character = getCharacterFromMemberElement(memberElement);
    if (!character) return;

    const iconBlock = memberElement.find('.group_member_icon').first();
    if (!iconBlock.length) return;

    if (!memberElement.find('.group_member_preset_select').length) {
        const select = createPresetSelect(group, character);
        const anchor = iconBlock.find('[data-action="enable"]').first();
        if (anchor.length) anchor.after(select);
        else iconBlock.prepend(select);
    }

    if (!memberElement.find('.group_member_director_controls').length) {
        const controls = $('<div class="group_member_director_controls flex-container flexGap5"></div>');
        controls.append(createCategoryCheckbox(group, character, 'role'));
        controls.append(createCategoryCheckbox(group, character, 'narration'));
        iconBlock.find('.group_member_preset_select').after(controls);
    }
}

function decorateGroupMembers() {
    if (isApplyingPreset) return;
    const group = getCurrentGroup();
    if (!group) return;

    $('.rm_group_members .group_member').each(function () {
        decorateGroupMember($(this), group);
    });
}

function ensureDirectorControls() {
    if ($('#group_member_presets_director_controls').length) return;

    const controls = $(
        `<div id="group_member_presets_director_controls" class="flex-container flexFlowColumn flexGap5 marginTopBot5">
            <div class="flex-container flexGap5 alignitemscenter">
                <label class="checkbox_label" title="Enable Director Mode for this group.">
                    <input id="group_member_presets_director_enabled" type="checkbox" />
                    <span>Director Mode</span>
                </label>
                <div id="group_member_presets_analyze" class="menu_button menu_button_icon" title="Analyze the latest user input and select acting characters.">
                    <i class="fa-solid fa-magnifying-glass-chart"></i><span>Analyze Action</span>
                </div>
                <div id="group_member_presets_confirm" class="menu_button menu_button_icon" title="Generate replies for unmuted role characters in order.">
                    <i class="fa-solid fa-check"></i><span>Confirm Action</span>
                </div>
                <div id="group_member_presets_prompt" class="menu_button menu_button_icon" title="Edit the action analysis prompt.">
                    <i class="fa-solid fa-pen-to-square"></i><span>Analysis Prompt</span>
                </div>
            </div>
            <div class="flex-container flexGap5 alignitemscenter">
                <div id="group_member_presets_roles_tab" class="menu_button menu_button_icon" data-tab="roles" title="Select characters that can take direct action.">
                    <i class="fa-solid fa-users"></i><span>Role</span>
                </div>
                <div id="group_member_presets_narrators_tab" class="menu_button menu_button_icon" data-tab="narrators" title="Select characters that can narrate after role actions.">
                    <i class="fa-solid fa-book-open"></i><span>Narration</span>
                </div>
            </div>
            <div id="group_member_presets_category_panel" class="flex-container flexGap5 flexWrap"></div>
            <small id="group_member_presets_director_status" class="opacity50p">Director Mode is handled by the Group Member Response Presets extension.</small>
        </div>`,
    );

    $('#rm_group_top_bar').before(controls);

    $('#group_member_presets_director_enabled').on('change', function () {
        const group = getCurrentGroup();
        if (!group) return;
        getDirectorSettings(group.id).directorMode = !!$(this).prop('checked');
        saveSettingsDebounced();
        syncDirectorControls();
    });

    $('#group_member_presets_analyze').on('click', analyzeAction);
    $('#group_member_presets_confirm').on('click', confirmAction);
    $('#group_member_presets_prompt').on('click', editAnalysisPrompt);
    $('#group_member_presets_roles_tab, #group_member_presets_narrators_tab').on('click', function () {
        activeCategoryTab = String($(this).data('tab'));
        renderCategoryPanel();
    });
}

function syncDirectorControls() {
    const group = getCurrentGroup();
    const director = group ? getDirectorSettings(group.id) : null;
    $('#group_member_presets_director_enabled').prop('checked', !!director?.directorMode);
    $('#rm_group_activation_strategy').find(`option[value="${directorStrategyValue}"]`).remove();
    if (director?.directorMode) {
        $('#rm_group_activation_strategy').append($('<option></option>', { value: directorStrategyValue, text: 'Director Mode', selected: true }));
    }
    renderCategoryPanel();
}

function renderCategoryPanel() {
    const group = getCurrentGroup();
    const panel = $('#group_member_presets_category_panel');
    panel.empty();

    $('#group_member_presets_roles_tab').toggleClass('selected', activeCategoryTab === 'roles');
    $('#group_member_presets_narrators_tab').toggleClass('selected', activeCategoryTab === 'narrators');

    if (!group) return;

    const director = getDirectorSettings(group.id);
    const targetList = activeCategoryTab === 'roles' ? director.roles : director.narrators;
    const label = activeCategoryTab === 'roles' ? 'Role' : 'Narration';

    for (const avatar of group.members) {
        const character = getCharacterByAvatar(avatar);
        if (!character) continue;

        const item = $('<label class="checkbox_label group_member_presets_category_item"></label>');
        const checkbox = $('<input type="checkbox" />')
            .prop('checked', targetList.includes(avatar))
            .on('change', function () {
                const index = targetList.indexOf(avatar);
                if ($(this).prop('checked') && index === -1) {
                    targetList.push(avatar);
                } else if (!$(this).prop('checked') && index !== -1) {
                    targetList.splice(index, 1);
                }
                saveSettingsDebounced();
                decorateGroupMembers();
            });
        item.append(checkbox, $('<span></span>').text(`${label}: ${character.name}`));
        panel.append(item);
    }
}

function setStatus(text) {
    $('#group_member_presets_director_status').text(text);
}

function getLatestUserInput() {
    const textarea = String($('#send_textarea').val() || '').trim();
    if (textarea) return textarea;
    return [...chat].reverse().find(message => message.is_user && message.mes)?.mes || '';
}

function parseAnalysisResult(text, roleCharacters) {
    const fallback = [];
    try {
        const match = String(text).match(/\{[\s\S]*\}/);
        const data = JSON.parse(match ? match[0] : text);
        const names = Array.isArray(data?.actors) ? data.actors : [];
        return names
            .map(name => roleCharacters.find(character => character.name === name))
            .filter(Boolean)
            .map(character => character.avatar);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Could not parse action analysis JSON`, error, text);
        return fallback;
    }
}

async function setDisabledMembers(group, disabledMembers) {
    group.disabled_members = [...new Set(disabledMembers)];
    await saveGroup(group);
    decorateGroupMembers();
}

async function saveGroup(group) {
    await fetch('/api/groups/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(group),
    });
}

async function analyzeAction() {
    const group = getCurrentGroup();
    if (!group) return toastr.warning('Open a group chat first.', 'Director Mode');

    const director = getDirectorSettings(group.id);
    if (!director.directorMode) return toastr.info('Enable Director Mode first.', 'Director Mode');

    const roleCharacters = director.roles.map(getCharacterByAvatar).filter(Boolean);
    if (!roleCharacters.length) return toastr.warning('Select at least one Role category member.', 'Director Mode');

    const input = getLatestUserInput();
    if (!input) return toastr.warning('No user input to analyze.', 'Director Mode');

    setStatus('Analyzing action...');
    const prompt = director.prompt
        .replace(/{{characters}}/g, roleCharacters.map(character => character.name).join(', '))
        .replace(/{{input}}/g, input);
    const result = await generateRaw({ prompt, systemPrompt: 'Return JSON only.' });
    const orderedAvatars = parseAnalysisResult(result, roleCharacters);

    if (!orderedAvatars.length) {
        await setDisabledMembers(group, group.members.slice());
        setStatus('Analysis finished: no role character needs action. Adjust manually or rerun analysis.');
        return;
    }

    disabledMembersSnapshot = group.disabled_members.slice();
    group.members = [...orderedAvatars, ...group.members.filter(avatar => !orderedAvatars.includes(avatar))];
    const disabled = group.members.filter(avatar => !orderedAvatars.includes(avatar));
    await setDisabledMembers(group, disabled);
    setStatus(`Analysis finished. Action order: ${orderedAvatars.map(avatar => getCharacterByAvatar(avatar)?.name).filter(Boolean).join(' -> ')}`);
}

async function confirmAction() {
    const group = getCurrentGroup();
    if (!group) return;

    const director = getDirectorSettings(group.id);
    if (!director.directorMode) return toastr.info('Enable Director Mode first.', 'Director Mode');

    const actors = group.members.filter(avatar => director.roles.includes(avatar) && !group.disabled_members.includes(avatar));
    if (!actors.length) return toastr.warning('No unmuted role characters to generate.', 'Director Mode');

    const startIndex = chat.length;
    setStatus('Generating role actions...');
    suppressNextWrapperRestore = true;
    for (const avatar of actors) {
        const chid = getCharacterIdByAvatar(avatar);
        if (chid !== -1) {
            await Generate('normal', { force_chid: chid });
        }
    }

    director.lastRoleMessageStart = startIndex;
    director.lastRoleMessageEnd = chat.length;
    director.awaitingNarration = true;
    saveSettingsDebounced();
    setStatus('Role actions generated. Send the next user instruction to trigger narration members.');
}

async function editAnalysisPrompt() {
    const group = getCurrentGroup();
    if (!group) return;
    const director = getDirectorSettings(group.id);
    const value = await callGenericPrompt(director.prompt);
    if (value !== null) {
        director.prompt = value || defaultPrompt;
        saveSettingsDebounced();
    }
}

async function callGenericPrompt(value) {
    return await Popup.show.input('Edit Director Mode action analysis prompt', 'Available macros: {{characters}}, {{input}}', value, { rows: 10 });
}

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
        console.warn(`[${MODULE_NAME}] AI response preset not found for ${getApiId()}: ${presetName}`);
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

async function onGenerationAfterCommands(type, _options, dryRun) {
    const group = getCurrentGroup();
    if (!group || dryRun) return;

    const director = getDirectorSettings(group.id);
    if (!director.directorMode || !director.awaitingNarration || type !== 'normal') return;

    disabledMembersSnapshot = group.disabled_members.slice();
    const allowed = new Set(director.narrators);
    await setDisabledMembers(group, group.members.filter(avatar => !allowed.has(avatar)));
    director.awaitingNarration = false;
    director.hideAfterNarration = true;
    saveSettingsDebounced();
}

async function onGroupWrapperStarted() {
    restorePresetSnapshot = getPresetSnapshot();
}

async function onGroupMemberDrafted(chId) {
    if (!selected_group) return;
    const character = characters[chId];
    if (!character) return;
    if (!restorePresetSnapshot) restorePresetSnapshot = getPresetSnapshot();

    const presetName = getSettings().groups?.[selected_group]?.[character.avatar]?.[getApiId()];
    selectPresetByName(presetName);
}

async function onGroupWrapperFinished() {
    const group = getCurrentGroup();
    const director = group ? getDirectorSettings(group.id) : null;

    if (restorePresetSnapshot && !suppressNextWrapperRestore) {
        const manager = getManager();
        if (manager && restorePresetSnapshot.apiId === getApiId()) {
            isApplyingPreset = true;
            try {
                manager.selectPreset(restorePresetSnapshot.presetValue);
            } finally {
                isApplyingPreset = false;
            }
        }
    }

    suppressNextWrapperRestore = false;
    restorePresetSnapshot = null;

    if (group && Array.isArray(disabledMembersSnapshot)) {
        await setDisabledMembers(group, disabledMembersSnapshot);
        disabledMembersSnapshot = null;
    }

    if (director?.hideAfterNarration) {
        hideRoleMessages(director);
        director.hideAfterNarration = false;
        saveSettingsDebounced();
        await saveChatConditional();
    }
}

function hideRoleMessages(director) {
    const start = Number(director.lastRoleMessageStart ?? -1);
    const end = Number(director.lastRoleMessageEnd ?? -1);
    if (start < 0 || end <= start) return;

    for (let index = start; index < end; index++) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system) continue;
        message.extra ??= {};
        message.extra.display_text = '[Director Mode role action hidden]';
        $(`#chat .mes[mesid="${index}"] .mes_text`).text(message.extra.display_text);
    }
}

function observeMemberList() {
    memberListObserver?.disconnect();
    const target = document.querySelector('#rm_group_members');
    if (!target) return;

    memberListObserver = new MutationObserver(() => decorateGroupMembers());
    memberListObserver.observe(target, { childList: true, subtree: true });
}

export async function init() {
    getSettings();
    ensureDirectorControls();
    observeMemberList();
    decorateGroupMembers();
    syncDirectorControls();

    eventSource.on('groupSelected', () => { ensureDirectorControls(); syncDirectorControls(); decorateGroupMembers(); });
    eventSource.on(event_types.CHAT_CHANGED, () => { syncDirectorControls(); decorateGroupMembers(); });
    eventSource.on(event_types.GROUP_UPDATED, decorateGroupMembers);
    eventSource.on(event_types.SETTINGS_UPDATED, decorateGroupMembers);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.GROUP_WRAPPER_STARTED, onGroupWrapperStarted);
    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
    eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
}
