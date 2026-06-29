import {
    characters,
    chat,
    eventSource,
    event_types,
    Generate,
    getCharacterCardFields,
    getRequestHeaders,
    main_api,
    max_context,
    saveSettingsDebounced,
} from '/script.js';
import { extension_settings, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { getPresetManager } from '/scripts/preset-manager.js';
import { groups, selected_group } from '/scripts/group-chats.js';
import { hideChatMessageRange } from '/scripts/chats.js';
import { getWorldInfoPrompt, world_info_include_names } from '/scripts/world-info.js';

export { MODULE_NAME };

const MODULE_NAME = 'groupMemberPresets';
const directorStrategyValue = 'director';

const defaultPrompt = `Analyze the user's latest input for a SillyTavern group chat.
Return JSON only in this format: {"actors":["Character Name 1","Character Name 2"]}
Include only characters that need to take action now. Sort them in the likely action order.
Available action-role characters: {{characters}}
User input: {{input}}`;

const defaultAnalysisPromptMessages = [
    { role: 'system', content: '你是一个助手，负责听从用户的指令完成你的工作' },
    { role: 'assistant', content: '收到，我将充分描绘主人的意志，毫不偷懒，并且我一定会遵照主人的要求' },
    { role: 'user', content: `以下是你可能需要用到的背景设定，注意你只需要其中关于剧情以及人设方面的数据，不需要思考里边除此之外的任何格式或者思维链方面的要求：
<背景设定>
{{worldInfo}}
</背景设定>
<正文数据>
{{context}}
</正文数据>` },
    { role: 'assistant', content: '收到，我将按照要求认真阅读背景设定，并将其中关于剧情以及人设方面的数据运用到后续思考当中。' },
    { role: 'user', content: `你是【分析AI】，负责根据用户提供的资料进行分析。
## 核心任务
依据以下资料来源执行分析任务，确定本轮需要行动的角色：
- <背景设定>：故事及人物设定
- <正文数据>：上轮发生的故事
{{format}}` },
];

const defaultSettings = {
    /** @type {Record<string, Record<string, Record<string, string>>>} groupId -> avatar -> apiId -> presetName */
    groups: {},
    /** @type {Record<string, {roles: string[], narrators: string[], prompt: string, directorMode: boolean}>} */
    director: {},
    analysisApi: {
        endpoint: '',
        key: '',
        model: '',
        bodyParams: '{\n  "temperature": 0.2\n}',
        excludeBodyParams: '',
        includeTags: '',
        excludeTags: '',
        includeTagRules: '',
        excludeTagRules: '',
        prompt: defaultPrompt,
        promptMessages: structuredClone(defaultAnalysisPromptMessages),
    },
};

let restorePresetSnapshot = null;
let disabledMembersSnapshot = null;
let isApplyingPreset = false;
let memberListObserver = null;
let suppressNextWrapperRestore = false;
let activeCategoryTab = 'roles';
let settingsObserver = null;
let settingsRendered = false;

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

function getAnalysisApiSettings() {
    const settings = getSettings();
    settings.analysisApi ??= structuredClone(defaultSettings.analysisApi);
    for (const [key, value] of Object.entries(defaultSettings.analysisApi)) {
        if (settings.analysisApi[key] === undefined) {
            settings.analysisApi[key] = structuredClone(value);
        }
    }
    settings.analysisApi.prompt ||= defaultPrompt;
    if (!Array.isArray(settings.analysisApi.promptMessages) || !settings.analysisApi.promptMessages.length) {
        settings.analysisApi.promptMessages = settings.analysisApi.prompt && settings.analysisApi.prompt !== defaultPrompt
            ? [{ role: 'user', content: settings.analysisApi.prompt }]
            : structuredClone(defaultAnalysisPromptMessages);
    }
    return settings.analysisApi;
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

function syncSettingsUi() {
    const analysisApi = getAnalysisApiSettings();
    $('#group_member_presets_analysis_endpoint').val(analysisApi.endpoint);
    $('#group_member_presets_analysis_key').val(analysisApi.key);
    $('#group_member_presets_analysis_model').val(analysisApi.model);
    $('#group_member_presets_analysis_body_params').val(analysisApi.bodyParams);
    $('#group_member_presets_analysis_exclude_body_params').val(analysisApi.excludeBodyParams);
    $('#group_member_presets_analysis_include_tags').val(analysisApi.includeTagRules || analysisApi.includeTags);
    $('#group_member_presets_analysis_exclude_tags').val(analysisApi.excludeTagRules || analysisApi.excludeTags);
    renderAnalysisPromptMessages();
}

function renderAnalysisPromptMessages() {
    const list = $('#group_member_presets_analysis_prompt_messages');
    if (!list.length) return;

    const analysisApi = getAnalysisApiSettings();
    list.empty();
    analysisApi.promptMessages.forEach((message, index) => {
        const item = $(
            `<div class="group_member_presets_prompt_message flex-container flexFlowColumn flexGap5 marginTopBot5" data-index="${index}">
                <div class="flex-container flexGap5 alignitemscenter">
                    <select class="text_pole textarea_compact group_member_presets_prompt_role">
                        <option value="system">system</option>
                        <option value="user">user</option>
                        <option value="assistant">assistant</option>
                    </select>
                    <div class="menu_button menu_button_icon group_member_presets_prompt_up" title="Move up"><i class="fa-solid fa-arrow-up"></i></div>
                    <div class="menu_button menu_button_icon group_member_presets_prompt_down" title="Move down"><i class="fa-solid fa-arrow-down"></i></div>
                    <div class="menu_button menu_button_icon group_member_presets_prompt_delete" title="Delete"><i class="fa-solid fa-trash"></i></div>
                </div>
                <textarea class="text_pole textarea_compact group_member_presets_prompt_content" rows="7"></textarea>
            </div>`,
        );
        item.find('.group_member_presets_prompt_role').val(message.role || 'user');
        item.find('.group_member_presets_prompt_content').val(message.content || '');
        list.append(item);
    });
}

function bindSettingsUi() {
    if (!$('#group_member_presets_analysis_endpoint').length) return false;
    syncSettingsUi();
    $('#group_member_presets_analysis_endpoint, #group_member_presets_analysis_key, #group_member_presets_analysis_model, #group_member_presets_analysis_body_params, #group_member_presets_analysis_exclude_body_params, #group_member_presets_analysis_include_tags, #group_member_presets_analysis_exclude_tags')
        .off('input.groupMemberPresets change.groupMemberPresets')
        .on('input.groupMemberPresets change.groupMemberPresets', function () {
            const analysisApi = getAnalysisApiSettings();
            analysisApi.endpoint = String($('#group_member_presets_analysis_endpoint').val() || '').trim();
            analysisApi.key = String($('#group_member_presets_analysis_key').val() || '');
            analysisApi.model = String($('#group_member_presets_analysis_model').val() || '').trim();
            analysisApi.bodyParams = String($('#group_member_presets_analysis_body_params').val() || '');
            analysisApi.excludeBodyParams = String($('#group_member_presets_analysis_exclude_body_params').val() || '');
            analysisApi.includeTagRules = String($('#group_member_presets_analysis_include_tags').val() || '');
            analysisApi.excludeTagRules = String($('#group_member_presets_analysis_exclude_tags').val() || '');
            saveSettingsDebounced();
        });
    $('#group_member_presets_analysis_prompt_messages')
        .off('input.groupMemberPresets change.groupMemberPresets click.groupMemberPresets')
        .on('input.groupMemberPresets change.groupMemberPresets', '.group_member_presets_prompt_role, .group_member_presets_prompt_content', savePromptMessagesFromUi)
        .on('click.groupMemberPresets', '.group_member_presets_prompt_up, .group_member_presets_prompt_down, .group_member_presets_prompt_delete', function () {
            const analysisApi = getAnalysisApiSettings();
            const index = Number($(this).closest('.group_member_presets_prompt_message').attr('data-index'));
            if (!Number.isInteger(index)) return;
            if ($(this).hasClass('group_member_presets_prompt_delete')) {
                analysisApi.promptMessages.splice(index, 1);
            } else if ($(this).hasClass('group_member_presets_prompt_up') && index > 0) {
                [analysisApi.promptMessages[index - 1], analysisApi.promptMessages[index]] = [analysisApi.promptMessages[index], analysisApi.promptMessages[index - 1]];
            } else if ($(this).hasClass('group_member_presets_prompt_down') && index < analysisApi.promptMessages.length - 1) {
                [analysisApi.promptMessages[index + 1], analysisApi.promptMessages[index]] = [analysisApi.promptMessages[index], analysisApi.promptMessages[index + 1]];
            }
            if (!analysisApi.promptMessages.length) {
                analysisApi.promptMessages.push({ role: 'user', content: '' });
            }
            renderAnalysisPromptMessages();
            saveSettingsDebounced();
        });
    $('#group_member_presets_analysis_prompt_add')
        .off('click.groupMemberPresets')
        .on('click.groupMemberPresets', function () {
            getAnalysisApiSettings().promptMessages.push({ role: 'user', content: '' });
            renderAnalysisPromptMessages();
            saveSettingsDebounced();
        });
    $('#group_member_presets_analysis_prompt_reset')
        .off('click.groupMemberPresets')
        .on('click.groupMemberPresets', function () {
            getAnalysisApiSettings().promptMessages = structuredClone(defaultAnalysisPromptMessages);
            renderAnalysisPromptMessages();
            saveSettingsDebounced();
        });
    return true;
}

function savePromptMessagesFromUi() {
    const analysisApi = getAnalysisApiSettings();
    analysisApi.promptMessages = $('#group_member_presets_analysis_prompt_messages .group_member_presets_prompt_message').toArray().map(element => {
        const item = $(element);
        return {
            role: String(item.find('.group_member_presets_prompt_role').val() || 'user'),
            content: String(item.find('.group_member_presets_prompt_content').val() || ''),
        };
    });
    saveSettingsDebounced();
}

function observeSettingsUi() {
    settingsObserver?.disconnect();
    if (bindSettingsUi()) return;

    settingsObserver = new MutationObserver(() => {
        if (bindSettingsUi()) {
            settingsObserver?.disconnect();
            settingsObserver = null;
        }
    });
    settingsObserver.observe(document.body, { childList: true, subtree: true });
}

async function renderSettingsPanel() {
    if (settingsRendered || document.getElementById('group_member_presets_settings')) return;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) return;

    const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    container.insertAdjacentHTML('beforeend', settingsHtml);
    settingsRendered = true;
    bindSettingsUi();
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
    let result;
    try {
        result = await generateActionAnalysis(roleCharacters, input);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Action analysis failed`, error);
        setStatus(`Analysis failed: ${error.message}`);
        toastr.error(error.message, 'Director Mode');
        return;
    }
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

function parseJsonObject(value, label) {
    const text = String(value || '').trim();
    if (!text) return {};
    try {
        const parsed = JSON.parse(text);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
            throw new Error(`${label} must be a JSON object.`);
        }
        return parsed;
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${error.message}`);
    }
}

function getExcludedBodyParams(value) {
    return String(value || '')
        .split(/[\n,]/)
        .map(x => x.trim())
        .filter(Boolean);
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTagRules(value) {
    return String(value || '')
        .split(/\n/)
        .map(x => x.trim())
        .filter(Boolean)
        .flatMap(line => line.includes('=>') ? [line] : line.split(',').map(x => x.trim()).filter(Boolean))
        .map(rule => {
            const separator = rule.includes('=>') ? '=>' : '|';
            const parts = rule.split(separator).map(x => x.trim()).filter(Boolean);
            if (parts.length >= 2) {
                return { start: parts[0], end: parts.slice(1).join(separator) };
            }

            const tag = parts[0]?.replace(/^<\/?/, '').replace(/>$/, '');
            return tag ? { start: `<${tag}>`, end: `</${tag}>` } : null;
        })
        .filter(Boolean);
}

function filterTextByTags(text, includeRules, excludeRules) {
    let result = String(text || '');
    const includes = getTagRules(includeRules);
    const excludes = getTagRules(excludeRules);

    if (includes.length) {
        const matches = [];
        for (const rule of includes) {
            const regex = new RegExp(`${escapeRegex(rule.start)}([\\s\\S]*?)${escapeRegex(rule.end)}`, 'gi');
            for (const match of result.matchAll(regex)) {
                matches.push(match[1].trim());
            }
        }
        result = matches.join('\n\n');
    }

    for (const rule of excludes) {
        const regex = new RegExp(`${escapeRegex(rule.start)}[\\s\\S]*?${escapeRegex(rule.end)}`, 'gi');
        result = result.replace(regex, '');
    }

    return result.trim();
}

async function getActionAnalysisWorldInfo(input, roleCharacters) {
    const visibleChat = getVisibleChatMessages();
    const chatForWI = visibleChat
        .map(message => world_info_include_names ? `${message.name}: ${message.mes}` : message.mes)
        .filter(Boolean)
        .reverse();
    if (input) {
        chatForWI.unshift(input);
    }

    const fields = roleCharacters.length === 1
        ? getCharacterCardFields({ chid: getCharacterIdByAvatar(roleCharacters[0].avatar) })
        : getCharacterCardFields();
    const globalScanData = {
        personaDescription: fields.persona,
        characterDescription: roleCharacters.map(character => character.description || character.data?.description || '').filter(Boolean).join('\n'),
        characterPersonality: roleCharacters.map(character => character.personality || character.data?.personality || '').filter(Boolean).join('\n'),
        characterDepthPrompt: fields.charDepthPrompt,
        scenario: fields.scenario,
        creatorNotes: fields.creatorNotes,
        trigger: 'normal',
    };
    return await getWorldInfoPrompt(chatForWI, max_context, false, globalScanData);
}

function getVisibleChatMessages() {
    return chat.filter(message => message?.mes && !message.is_system);
}

function getAnalysisContextText(input) {
    const messages = getVisibleChatMessages().map(message => `${message.name || (message.is_user ? 'User' : 'Assistant')}: ${message.mes}`);
    if (input && !messages[messages.length - 1]?.includes(input)) {
        messages.push(`User: ${input}`);
    }
    return messages.join('\n\n');
}

function getAnalysisFormatText(roleCharacters, input) {
    return `## 输出格式
Return JSON only in this format: {"actors":["Character Name 1","Character Name 2"]}
Include only characters that need to take action now. Sort them in the likely action order.
Available action-role characters: ${roleCharacters.map(character => character.name).join(', ')}
Latest user input: ${input}`;
}

function renderAnalysisPromptMessageContent(content, replacements) {
    return String(content || '')
        .replace(/{{worldInfo}}/g, replacements.worldInfo)
        .replace(/{{context}}/g, replacements.context)
        .replace(/{{format}}/g, replacements.format)
        .replace(/{{characters}}/g, replacements.characters)
        .replace(/{{input}}/g, replacements.input);
}

async function generateActionAnalysis(roleCharacters, input) {
    const analysisApi = getAnalysisApiSettings();
    if (!analysisApi.endpoint) {
        throw new Error('Configure the action analysis API endpoint in extension settings first.');
    }

    const worldInfo = await getActionAnalysisWorldInfo(input, roleCharacters);
    const worldInfoText = [
        worldInfo.worldInfoBefore,
        worldInfo.worldInfoString,
        worldInfo.worldInfoAfter,
        ...(worldInfo.worldInfoDepth || []).map(entry => entry.entries.join('\n')),
    ].filter(Boolean).join('\n\n');
    const replacements = {
        worldInfo: filterTextByTags(worldInfoText, analysisApi.includeTagRules || analysisApi.includeTags, analysisApi.excludeTagRules || analysisApi.excludeTags),
        context: filterTextByTags(getAnalysisContextText(input), analysisApi.includeTagRules || analysisApi.includeTags, analysisApi.excludeTagRules || analysisApi.excludeTags),
        format: getAnalysisFormatText(roleCharacters, input),
        characters: roleCharacters.map(character => character.name).join(', '),
        input,
    };
    const messages = analysisApi.promptMessages.map(message => ({
        role: ['system', 'user', 'assistant'].includes(message.role) ? message.role : 'user',
        content: renderAnalysisPromptMessageContent(message.content, replacements),
    })).filter(message => message.content.trim());
    if (!messages.length) {
        throw new Error('Configure at least one action analysis prompt message.');
    }
    const body = {
        ...parseJsonObject(analysisApi.bodyParams, 'Body parameters'),
        model: analysisApi.model,
        messages,
    };
    for (const key of getExcludedBodyParams(analysisApi.excludeBodyParams)) {
        delete body[key];
    }
    if (!body.model) {
        delete body.model;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (analysisApi.key) {
        headers.Authorization = `Bearer ${analysisApi.key}`;
    }
    const response = await fetch(analysisApi.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`Action analysis API failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    return data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.content ?? JSON.stringify(data);
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
    await renderSettingsPanel();
    const target = document.getElementById('group_member_presets_analysis_prompt_messages');
    if (target) {
        const drawer = $('#group_member_presets_settings .inline-drawer-content');
        if (drawer.length && !drawer.is(':visible')) {
            $('#group_member_presets_settings .inline-drawer-toggle').trigger('click');
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }
    toastr.info('Open the extension settings to edit action analysis prompt messages.', 'Director Mode');
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
        await hideRoleMessages(director);
        director.hideAfterNarration = false;
        saveSettingsDebounced();
    }
}

async function hideRoleMessages(director) {
    const start = Number(director.lastRoleMessageStart ?? -1);
    const end = Number(director.lastRoleMessageEnd ?? -1) - 1;
    if (start < 0 || end < start) return;

    await hideChatMessageRange(start, end, false);
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
    await renderSettingsPanel();
    observeSettingsUi();
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
