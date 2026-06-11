/**
 * Electron 主进程
 *
 * 启动内置的 Express 后端（使用 Electron 自带的 Node 运行），
 * 后端在生产模式下同时托管已构建的前端 (dist)，主窗口加载 http://localhost:3501。
 *
 * 配置文件与素材库写入用户数据目录，便于便携版正常读写。
 */

const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');

const PORT = 3501;
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess = null;
let mainWindow = null;

// 应用根目录：打包后位于 resources/app，开发时为项目根目录
const appRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '..');

const serverEntry = path.join(appRoot, 'server', 'index.js');

function startServer() {
    const userData = app.getPath('userData');

    const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        PORT: String(PORT),
        // 可写目录：密钥配置与素材库存放于用户数据目录
        CONFIG_DIR: userData,
        LIBRARY_DIR: path.join(userData, 'library'),
        LOCAL_MODELS_DIR: path.join(appRoot, 'models'),
    };

    serverProcess = fork(serverEntry, [], {
        env,
        cwd: appRoot,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    serverProcess.stdout && serverProcess.stdout.on('data', (d) => console.log('[server]', d.toString().trim()));
    serverProcess.stderr && serverProcess.stderr.on('data', (d) => console.error('[server]', d.toString().trim()));
    serverProcess.on('exit', (code) => console.log('[server] exited with code', code));
}

/**
 * 等待后端就绪。通过 /api/health 确认端口上运行的确实是本应用：
 * 若 3501 被其他程序（如开发模式的后端）占用，则返回 'foreign'。
 */
function waitForServer(timeoutMs = 30000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            const req = http.get(`${BASE_URL}/api/health`, (res) => {
                let body = '';
                res.on('data', (d) => { body += d; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        if (data.app === 'magical-canvas' && data.mode === 'production') return resolve('ok');
                    } catch (_) { /* 非本应用的响应 */ }
                    resolve('foreign');
                });
            });
            req.on('error', () => {
                if (Date.now() - start > timeoutMs) {
                    reject(new Error('后端启动超时'));
                } else {
                    setTimeout(tryOnce, 400);
                }
            });
        };
        tryOnce();
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: '#050505',
        autoHideMenuBar: true,
        title: 'Magical Canvas',
        icon: path.join(appRoot, 'build', 'icon.ico'),
        frame: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.cjs'),
        },
    });

    Menu.setApplicationMenu(null);

    mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximize-changed', true));
    mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximize-changed', false));

    // 在外部浏览器打开 target=_blank 链接（如 OAuth 授权弹窗）
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.loadURL(BASE_URL);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 窗口控制（无边框窗口的自定义按钮）
ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow && mainWindow.close());
ipcMain.handle('window:is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));

// 单实例锁，避免重复打开导致端口占用
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        startServer();
        try {
            const status = await waitForServer();
            if (status === 'foreign') {
                const { dialog } = require('electron');
                dialog.showErrorBox(
                    '端口被占用',
                    '端口 3501 已被其他程序占用（可能是正在运行的开发服务器）。\n\n请先关闭占用该端口的程序，再重新打开 Magical Canvas。'
                );
                app.quit();
                return;
            }
        } catch (err) {
            console.error(err);
        }
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
    if (serverProcess) {
        try { serverProcess.kill(); } catch (_) { /* noop */ }
    }
});
