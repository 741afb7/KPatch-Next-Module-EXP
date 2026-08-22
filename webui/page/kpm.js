import { exec, spawn, toast } from 'kernelsu-alt';
import { modDir, persistDir, initInfo, MAX_CHUNK_SIZE, escapeShell, linkRedirect } from '../index.js';
import { getString } from '../language.js';
import { setupPullToRefresh } from '../pull-to-refresh.js';

let allKpms = [];
let searchQuery = '';
let clickCount = 0;
let lastClickTime = 0;

function getInstalledKpmDir() {
    return `${persistDir}/installed-kpm`;
}

function parseModuleInfo(output) {
    const moduleInfo = {};
    output.trim().split('\n').forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key) moduleInfo[key] = valueParts.join('=');
    });
    return moduleInfo;
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function isValidInstalledModuleName(name) {
    return typeof name === 'string' && name.length > 0 && name.length < 128 &&
        name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name);
}

async function getKpmInfo(path) {
    const result = await exec(`kptools -l -M ${escapeShell(path)}`, { env: { PATH: `${modDir}/bin` } });
    if (import.meta.env.DEV) {
        result.stdout = 'name=Test Module\nversion=1.0.0\ndescription=This is a test module\nauthor=KOWX712\nlicense=MIT\nargs=test';
        result.errno = 0;
    }
    if (result.errno !== 0) return null;
    return parseModuleInfo(result.stdout);
}

async function getRuntimeKpms() {
    if (import.meta.env.DEV) {
        return [{
            name: 'Loaded Module',
            version: '1.0.0',
            description: 'A module loaded for this boot',
            author: 'KOWX712',
            license: 'MIT',
            args: 'test',
            load_event: 'load-file',
            load_source: 'file',
            loaded: true,
            installed: false,
        }];
    }

    const listResult = await exec('kpatch kpm list', { env: { PATH: `${modDir}/bin:$PATH` } });
    if (listResult.errno !== 0) return [];

    const moduleNames = listResult.stdout.trim().split('\n').filter(line => line.trim());
    return Promise.all(moduleNames.map(async moduleName => {
        const infoResult = await exec(`kpatch kpm info ${escapeShell(moduleName)}`, { env: { PATH: `${modDir}/bin` } });
        const info = infoResult.errno === 0 ? parseModuleInfo(infoResult.stdout) : {};
        return Object.assign(info, {
            name: info.name || moduleName,
            loaded: true,
            installed: false,
        });
    }));
}

async function getInstalledKpms() {
    if (import.meta.env.DEV) {
        return [{
            name: 'Installed Module',
            version: '2.0.0',
            description: 'A module installed for the next boot',
            author: 'KOWX712',
            license: 'MIT',
            args: '',
            loaded: false,
            installed: true,
            installedEnabled: false,
            installedPath: `${getInstalledKpmDir()}/Installed Module`,
        }];
    }

    const root = escapeShell(getInstalledKpmDir());
    const result = await exec(`if [ -d ${root} ]; then for path in ${root}/*; do [ -d "$path" ] && printf '%s\\n' "$path"; done; fi`);
    const paths = result.stdout.split('\n').map(path => path.replace(/\r$/, '')).filter(Boolean);

    const installed = await Promise.all(paths.map(async installedPath => {
        const installedId = installedPath.substring(installedPath.lastIndexOf('/') + 1);
        if (!isValidInstalledModuleName(installedId)) return null;

        const modulePath = `${installedPath}/${installedId}.kpm`;
        const exists = await exec(`[ -s ${escapeShell(modulePath)} ]`);
        if (exists.errno !== 0) return null;

        const info = await getKpmInfo(modulePath);
        if (!info || !isValidInstalledModuleName(info.name)) return null;

        const disabled = await exec(`[ -e ${escapeShell(`${installedPath}/disable`)} ]`);
        return Object.assign(info, {
            installedId,
            installedPath,
            installedEnabled: disabled.errno !== 0,
            installed: true,
            loaded: false,
        });
    }));

    return installed.filter(Boolean);
}

async function getKpmList() {
    const [runtimeKpms, installedKpms] = await Promise.all([getRuntimeKpms(), getInstalledKpms()]);
    const modules = new Map(runtimeKpms.map(module => [module.name, module]));

    installedKpms.forEach(installed => {
        const runtime = modules.get(installed.name);
        modules.set(installed.name, runtime ? Object.assign({}, installed, runtime, {
            installed: true,
            installedId: installed.installedId,
            installedPath: installed.installedPath,
            installedEnabled: installed.installedEnabled,
            loaded: true,
        }) : installed);
    });

    return Array.from(modules.values()).sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
}

async function controlModule(moduleName, action) {
    const result = await exec(`kpatch kpm ctl0 ${escapeShell(moduleName)} ${escapeShell(action)}`, { env: { PATH: `${modDir}/bin` } });
    toast(result.errno === 0 ? result.stdout : result.stderr);
}

async function forgetLoadedModule(moduleName) {
    return exec(`rm -f ${escapeShell(`${persistDir}/kpm/${moduleName}.kpm`)}`);
}

async function unloadModule(moduleName) {
    const result = await exec(`kpatch kpm unload ${escapeShell(moduleName)}`, { env: { PATH: `${modDir}/bin` } });
    return result.errno === 0;
}

async function loadModule(modulePath) {
    const result = await exec(`kpatch kpm load ${escapeShell(modulePath)}`, { env: { PATH: `${modDir}/bin` } });
    return result.errno === 0;
}

async function setInstalledModuleEnabled(module, enabled) {
    const marker = escapeShell(`${module.installedPath}/disable`);
    const result = enabled
        ? await exec(`rm -f ${marker}`)
        : await exec(`mkdir -p ${escapeShell(module.installedPath)} && : > ${marker}`);
    return result.errno === 0;
}

async function removeModule(module) {
    if (module.installed) {
        if (module.loaded && !await unloadModule(module.name)) {
            toast(getString('msg_failed_unload_module', module.name));
            return false;
        }
        const result = await exec(`rm -rf ${escapeShell(module.installedPath)}`);
        if (result.errno !== 0) {
            toast(getString('msg_failed_remove_installed_module', module.name));
            return false;
        }
        return true;
    }

    await forgetLoadedModule(module.name);
    if (!await unloadModule(module.name)) {
        toast(getString('msg_failed_unload_module', module.name));
        return false;
    }
    return true;
}

async function refreshKpmList() {
    const emptyMsg = document.getElementById('kpm-empty-msg');
    emptyMsg.textContent = getString('status_loading');
    emptyMsg.classList.remove('hidden');
    try {
        allKpms = await getKpmList();
    } catch (error) {
        console.error('Failed to refresh KPM list', error);
        allKpms = [];
    }
    renderKpmList();
}

function openControlDialog(module) {
    if (!module.loaded) return;
    const dialog = document.getElementById('control-dialog');
    const textField = dialog.querySelector('md-outlined-text-field');
    dialog.querySelector('.cancel').onclick = () => dialog.close();
    dialog.querySelector('.confirm').onclick = async () => {
        await controlModule(module.name, textField.value);
        await refreshKpmList();
        initInfo();
        textField.value = '';
        dialog.close();
    };
    dialog.show();
}

function openRemoveDialog(module) {
    const dialog = document.getElementById('unload-dialog');
    const message = module.installed ? 'msg_remove_installed_module' : 'msg_unload_module';
    dialog.querySelector('[slot=content]').textContent = getString(message, module.name);
    dialog.querySelector('.confirm').textContent = getString(module.installed ? 'button_remove' : 'button_unload');
    dialog.querySelector('.cancel').onclick = () => dialog.close();
    dialog.querySelector('.confirm').onclick = async () => {
        const confirm = dialog.querySelector('.confirm');
        confirm.disabled = true;
        if (await removeModule(module)) {
            await refreshKpmList();
            initInfo();
            dialog.close();
        }
        confirm.disabled = false;
    };
    dialog.show();
}

function renderKpmList() {
    const container = document.getElementById('kpm-list');
    container.innerHTML = '';

    allKpms.forEach(module => {
        const item = document.createElement('div');
        item.className = 'card module-card';
        const installTag = module.installed ? `<span class="tag">${escapeHtml(getString('label_install_mode'))}</span>` : '';
        const enabledSwitch = module.installed
            ? `<md-switch class="installed-toggle" aria-label="${escapeHtml(getString('label_enable_installed_module'))}" ${module.installedEnabled ? 'selected' : ''}></md-switch>`
            : '';

        item.innerHTML = `
            <div class="module-card-header">
                <div class="module-card-title-row">
                    <div class="module-card-title">${escapeHtml(module.name)}</div>
                    ${installTag}
                </div>
                <div class="module-card-subtitle">${escapeHtml(module.version || getString('msg_unknown'))}, ${escapeHtml(getString('info_author', module.author || getString('msg_unknown')))}</div>
                <div class="module-card-subtitle">${escapeHtml(getString('info_args', module.args || '(null)'))}</div>
            </div>
            <div class="module-card-content">
                <div class="module-card-text">${escapeHtml(module.description || getString('info_no_description'))}</div>
            </div>
            <md-divider></md-divider>
            <div class="module-card-actions">
                ${enabledSwitch}
                <md-filled-tonal-icon-button class="control" ${module.loaded ? '' : 'disabled'} aria-label="${escapeHtml(getString('title_control_kpmodule'))}">
                    <md-icon><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z" /></svg></md-icon>
                </md-filled-tonal-icon-button>
                <md-filled-tonal-icon-button class="unload" aria-label="${escapeHtml(getString(module.installed ? 'button_remove' : 'button_unload'))}">
                    <md-icon><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg></md-icon>
                </md-filled-tonal-icon-button>
            </div>
        `;

        item.querySelector('.control').onclick = () => openControlDialog(module);
        item.querySelector('.unload').onclick = () => openRemoveDialog(module);

        const toggle = item.querySelector('.installed-toggle');
        if (toggle) {
            toggle.addEventListener('change', async () => {
                const enabled = toggle.selected;
                toggle.disabled = true;
                if (await setInstalledModuleEnabled(module, enabled)) {
                    module.installedEnabled = enabled;
                } else {
                    toggle.selected = !enabled;
                    toast(getString('msg_failed_update_module_state', module.name));
                }
                toggle.disabled = false;
            });
        }
        container.appendChild(item);
    });

    applyFilters();
}

function applyFilters() {
    const query = searchQuery.toLowerCase();
    let visibleCount = 0;

    [...document.querySelectorAll('#kpm-list .module-card')].forEach((item, index) => {
        const module = allKpms[index];
        const isVisible = (module.name || '').toLowerCase().includes(query) ||
            (module.description || '').toLowerCase().includes(query);
        item.classList.toggle('search-hidden', !isVisible);
        if (isVisible) visibleCount++;
    });

    const emptyMsg = document.getElementById('kpm-empty-msg');
    if (visibleCount === 0) {
        emptyMsg.textContent = getString('msg_no_module_found');
        emptyMsg.classList.remove('hidden');
    } else {
        emptyMsg.classList.add('hidden');
    }
}

async function uploadFile(file, targetPath, onProgress, signal) {
    const CHUNK_SIZE = file.size > MAX_CHUNK_SIZE * 4 ? MAX_CHUNK_SIZE : Math.max(1, Math.ceil(file.size / 4));
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const CONCURRENCY = 8;

    await exec(`mkdir -p "$(dirname ${escapeShell(targetPath)})"`);

    let uploadedBytes = 0;
    let nextChunkIdx = 0;

    const processChunk = async (index) => {
        if (signal?.aborted) return;

        const start = index * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(chunk);
        });

        const partPath = `${targetPath}.part${index.toString().padStart(8, '0')}`;
        const result = await new Promise((resolve) => {
            const child = spawn(`echo '${base64}' | base64 -d > ${escapeShell(partPath)}`);
            child.on('exit', (code) => resolve({ errno: code }));
        });
        if (result.errno !== 0) throw new Error(`Write error at chunk ${index}`);

        uploadedBytes += end - start;
        if (onProgress) onProgress(uploadedBytes / file.size);
    };

    try {
        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, totalChunks); i++) {
            workers.push((async () => {
                while (nextChunkIdx < totalChunks && !signal?.aborted) {
                    await processChunk(nextChunkIdx++);
                }
            })());
        }
        await Promise.all(workers);

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (totalChunks === 0) {
            await exec(`: > ${escapeShell(targetPath)}`);
            return;
        }

        const combineResult = await new Promise((resolve) => {
            const child = spawn(`cat ${escapeShell(targetPath)}.part* > ${escapeShell(targetPath)} && rm -f ${escapeShell(targetPath)}.part*`);
            child.on('exit', (code) => resolve({ errno: code }));
        });
        if (combineResult.errno !== 0) throw new Error('Merge error');
    } catch (err) {
        await exec(`rm -f ${escapeShell(targetPath)}.part*`);
        throw err;
    }
}

function checkFileUploadApi() {
    const currentTime = Date.now();
    clickCount = currentTime - lastClickTime > 2000 ? 1 : clickCount + 1;
    lastClickTime = currentTime;
    if (clickCount === 3) {
        clickCount = 0;
        linkRedirect('https://github.com/KOWX712/KsuWebUIStandalone/releases/latest');
    }
}

async function handleFileUpload(accept, containerId, onSelected) {
    checkFileUploadApi();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (accept && !file.name.endsWith(accept)) {
            toast(getString('msg_please_select_file', accept));
            return;
        }

        const abortController = new AbortController();
        const loadingCard = document.createElement('div');
        loadingCard.className = 'card module-card';
        loadingCard.innerHTML = `
            <div class="module-card-header flex-header">
                <div class="header-info">
                    <div class="module-card-title">${escapeHtml(file.name)}</div>
                    <div class="module-card-subtitle" id="upload-progress-text">${escapeHtml(getString('msg_please_wait'))}</div>
                </div>
                <md-outlined-icon-button id="cancel-upload" aria-label="${escapeHtml(getString('button_cancel'))}">
                    <md-icon><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg></md-icon>
                </md-outlined-icon-button>
            </div>
            <div class="module-card-content"><md-linear-progress indeterminate></md-linear-progress></div>
        `;
        document.getElementById(containerId).prepend(loadingCard);

        const progressBar = loadingCard.querySelector('md-linear-progress');
        const progressText = loadingCard.querySelector('#upload-progress-text');
        loadingCard.querySelector('#cancel-upload').onclick = () => abortController.abort();

        try {
            await onSelected(file, percent => {
                progressBar.value = percent;
                progressBar.indeterminate = false;
                progressText.textContent = getString('msg_uploading', `${Math.round(percent * 100)}%`);
            }, abortController.signal);
        } catch (err) {
            toast(err.name === 'AbortError' ? getString('msg_upload_cancelled') : getString('msg_error', err.message));
        } finally {
            loadingCard.remove();
        }
    };
    input.click();
}

async function prepareUpload(file, onProgress, signal) {
    const tmpDir = `${modDir}/tmp`;
    const tmpPath = `${tmpDir}/upload.kpm`;
    await exec(`mkdir -p ${escapeShell(tmpDir)} && rm -rf ${escapeShell(tmpDir)}/*`);
    await uploadFile(file, tmpPath, onProgress, signal);
    return { tmpDir, tmpPath, info: await getKpmInfo(tmpPath) };
}

async function uploadAndLoadModule() {
    const loadBtn = document.getElementById('load');
    handleFileUpload('.kpm', 'kpm-list', async (file, onProgress, signal) => {
        loadBtn.classList.add('hide');
        const tmpDir = `${modDir}/tmp`;
        try {
            const { tmpPath, info } = await prepareUpload(file, onProgress, signal);
            if (!info || !info.name) {
                toast(getString('msg_failed_get_module_info'));
                await exec(`rm -rf ${escapeShell(tmpDir)}`);
                return;
            }

            const dialog = document.getElementById('load-dialog');
            dialog.querySelector('#load-module-msg').textContent = getString('msg_module_loaded', info.name);
            const checkbox = dialog.querySelector('md-checkbox');
            checkbox.checked = false;
            dialog.querySelector('.cancel').onclick = () => {
                dialog.close();
                exec(`rm -rf ${escapeShell(tmpDir)}`);
            };
            const confirm = dialog.querySelector('.confirm');
            confirm.onclick = async () => {
                confirm.disabled = true;
                try {
                    const success = await loadModule(tmpPath);
                    if (success) {
                        if (!checkbox.checked) {
                            const legacyDir = `${persistDir}/kpm`;
                            await exec(`mkdir -p ${escapeShell(legacyDir)} && cp -f ${escapeShell(tmpPath)} ${escapeShell(`${legacyDir}/${info.name}.kpm`)}`);
                        }
                        toast(getString('msg_successfully_loaded', info.name));
                        await refreshKpmList();
                    } else {
                        toast(getString('msg_failed_load_module', info.name));
                    }
                } finally {
                    await exec(`rm -rf ${escapeShell(tmpDir)}`);
                    confirm.disabled = false;
                    dialog.close();
                }
            };
            dialog.show();
        } catch (err) {
            await exec(`rm -rf ${escapeShell(tmpDir)}`);
            throw err;
        } finally {
            loadBtn.classList.remove('hide');
        }
    });
}

async function uploadAndInstallModule() {
    const loadBtn = document.getElementById('load');
    handleFileUpload('.kpm', 'kpm-list', async (file, onProgress, signal) => {
        loadBtn.classList.add('hide');
        const tmpDir = `${modDir}/tmp`;
        try {
            const { tmpPath, info } = await prepareUpload(file, onProgress, signal);
            if (!info || !isValidInstalledModuleName(info.name)) {
                toast(getString('msg_invalid_kpm_name'));
                await exec(`rm -rf ${escapeShell(tmpDir)}`);
                return;
            }

            const dialog = document.getElementById('install-dialog');
            dialog.querySelector('#install-module-msg').textContent = getString('msg_install_module', info.name);
            dialog.querySelector('.cancel').onclick = () => {
                dialog.close();
                exec(`rm -rf ${escapeShell(tmpDir)}`);
            };
            const confirm = dialog.querySelector('.confirm');
            confirm.onclick = async () => {
                confirm.disabled = true;
                const targetDir = `${getInstalledKpmDir()}/${info.name}`;
                const target = `${targetDir}/${info.name}.kpm`;
                const staged = `${target}.new`;
                try {
                    const result = await exec(`mkdir -p ${escapeShell(targetDir)} && cp -f ${escapeShell(tmpPath)} ${escapeShell(staged)} && chmod 600 ${escapeShell(staged)} && mv -f ${escapeShell(staged)} ${escapeShell(target)}`);
                    if (result.errno === 0) {
                        toast(getString('msg_successfully_installed', info.name));
                        await refreshKpmList();
                    } else {
                        await exec(`rm -f ${escapeShell(staged)}`);
                        toast(getString('msg_failed_install_module', info.name));
                    }
                } finally {
                    await exec(`rm -rf ${escapeShell(tmpDir)}`);
                    confirm.disabled = false;
                    dialog.close();
                }
            };
            dialog.show();
        } catch (err) {
            await exec(`rm -rf ${escapeShell(tmpDir)}`);
            throw err;
        } finally {
            loadBtn.classList.remove('hide');
        }
    });
}

function openModeDialog() {
    const dialog = document.getElementById('kpm-mode-dialog');
    dialog.querySelector('.cancel').onclick = () => dialog.close();
    dialog.querySelector('.load-mode').onclick = () => {
        dialog.close();
        uploadAndLoadModule();
    };
    dialog.querySelector('.install-mode').onclick = () => {
        dialog.close();
        uploadAndInstallModule();
    };
    dialog.show();
}

export function initKPMPage() {
    const searchBtn = document.getElementById('kpm-search-btn');
    const searchBar = document.getElementById('kpm-search-bar');
    const closeBtn = document.getElementById('close-kpm-search-btn');
    const searchInput = document.getElementById('kpm-search-input');
    const menuBtn = document.getElementById('kpm-menu-btn');
    const menu = document.getElementById('kpm-menu');

    searchBtn.onclick = () => {
        searchBar.classList.add('show');
        document.querySelectorAll('.search-bg').forEach(el => el.classList.add('hide'));
        searchInput.focus();
    };
    closeBtn.onclick = () => {
        searchBar.classList.remove('show');
        document.querySelectorAll('.search-bg').forEach(el => el.classList.remove('hide'));
        searchQuery = '';
        searchInput.blur();
        searchInput.value = '';
        applyFilters();
    };
    searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        applyFilters();
    });

    menuBtn.onclick = () => menu.show();
    document.getElementById('refresh-kpm-list-menu').onclick = () => refreshKpmList();

    const controlDialog = document.getElementById('control-dialog');
    const controlTextField = controlDialog.querySelector('md-outlined-text-field');
    controlTextField.addEventListener('input', () => {
        controlDialog.querySelector('.confirm').disabled = !controlTextField.value;
    });

    document.getElementById('load').onclick = () => openModeDialog();
    setupPullToRefresh(document.querySelector('#kpm-page .page-content'), refreshKpmList);
}

export { loadModule, refreshKpmList, handleFileUpload, uploadFile };