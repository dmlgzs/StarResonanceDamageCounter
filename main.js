const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const cap = require('cap');

// 保持对窗口对象的全局引用，如果不这样做的话，当JavaScript对象被垃圾回收时，窗口会被自动关闭
let mainWindow;
let tray;
let serverProcess;

// 获取可用的网络设备
function getNetworkDevices() {
    try {
        const devices = cap.deviceList();
        return devices.map((device, index) => ({
            index,
            name: device.name,
            description: device.description || device.name,
            addresses: device.addresses || []
        }));
    } catch (error) {
        console.error('获取网络设备失败:', error);
        return [];
    }
}

function createWindow() {
    // 创建浏览器窗口
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        // icon: path.join(__dirname, 'assets/icon.png'), // 可选图标
        title: '星痕共鸣伤害统计工具',
        show: false, // 先不显示，等加载完成后再显示
        titleBarStyle: 'default'
    });

    // 窗口准备好后显示
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        
        // 开发模式下打开开发者工具
        if (process.argv.includes('--dev')) {
            mainWindow.webContents.openDevTools();
        }
    });

    // 加载设备选择页面
    mainWindow.loadFile('public/setup.html');

    // 当窗口被关闭时发出
    mainWindow.on('closed', () => {
        mainWindow = null;
        if (serverProcess) {
            serverProcess.kill();
        }
    });

    // 处理外部链接
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

function createTray() {
    // 暂时跳过托盘图标，避免文件不存在的错误
    // const trayIconPath = path.join(__dirname, 'assets/tray-icon.png');
    // tray = new Tray(trayIconPath);
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: '显示主窗口',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        {
            label: '打开数据页面',
            click: () => {
                shell.openExternal('http://localhost:8989');
            }
        },
        { type: 'separator' },
        {
            label: '退出',
            click: () => {
                app.quit();
            }
        }
    ]);
    
    // tray.setToolTip('星痕共鸣伤害统计工具');
    // tray.setContextMenu(contextMenu);
    
    // tray.on('double-click', () => {
    //     if (mainWindow) {
    //         mainWindow.show();
    //         mainWindow.focus();
    //     }
    // });
}

// 启动服务器进程
function startServer(deviceIndex, logLevel = 'info') {
    return new Promise((resolve, reject) => {
        try {
            // 直接引入并运行服务器代码
            process.env.DEVICE_INDEX = deviceIndex.toString();
            process.env.LOG_LEVEL = logLevel;
            
            // 动态引入服务器模块
            delete require.cache[require.resolve('./server.js')];
            require('./server.js');
            
            resolve();
        } catch (error) {
            reject(error);
        }
    });
}

// IPC 事件处理
ipcMain.handle('get-network-devices', async () => {
    return getNetworkDevices();
});

ipcMain.handle('start-server', async (event, { deviceIndex, logLevel }) => {
    try {
        await startServer(deviceIndex, logLevel);
        
        // 切换到主界面
        setTimeout(() => {
            mainWindow.loadURL('http://localhost:8989');
        }, 2000);
        
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('show-error-dialog', async (event, { title, message }) => {
    dialog.showErrorBox(title, message);
});

ipcMain.handle('show-info-dialog', async (event, { title, message }) => {
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title,
        message,
        buttons: ['确定']
    });
});

// 应用程序事件
app.whenReady().then(() => {
    createWindow();
    // createTray(); // 暂时禁用托盘功能
});

app.on('window-all-closed', () => {
    // 在 macOS 上，除非用户用 Cmd + Q 确定地退出，否则绝大部分应用会保持激活状态，即使没有打开的窗口
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    // 在macOS上，当单击dock图标并且没有其他窗口打开时，通常在应用程序中重新创建一个窗口
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
});

// 设置应用程序菜单
const template = [
    {
        label: '文件',
        submenu: [
            {
                label: '重新启动',
                accelerator: 'CmdOrCtrl+R',
                click: () => {
                    app.relaunch();
                    app.exit();
                }
            },
            { type: 'separator' },
            {
                label: '退出',
                accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
                click: () => {
                    app.quit();
                }
            }
        ]
    },
    {
        label: '查看',
        submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' }
        ]
    },
    {
        label: '窗口',
        submenu: [
            { role: 'minimize' },
            { role: 'close' }
        ]
    },
    {
        label: '帮助',
        submenu: [
            {
                label: '关于',
                click: () => {
                    dialog.showMessageBox(mainWindow, {
                        type: 'info',
                        title: '关于',
                        message: '星痕共鸣伤害统计工具',
                        detail: 'Version 2.1.0\n\n一个用于《星痕共鸣》游戏的实时战斗数据统计工具。\n\n作者: Dimole <dmlgzs@qq.com>\n许可证: MPL-2.0'
                    });
                }
            },
            {
                label: '项目主页',
                click: () => {
                    shell.openExternal('https://github.com/dmlgzs/StarResonanceDamageCounter');
                }
            }
        ]
    }
];

if (process.platform === 'darwin') {
    template.unshift({
        label: app.getName(),
        submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
        ]
    });
}

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);