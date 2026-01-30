// Enable V8 code caching for faster startup
require('v8-compile-cache');

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// Linux shared memory fix for Chromium
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}

// Set a unique user data path
const userDataPath = path.join(os.homedir(), '.config', 'by-metes-and-bounds');
app.setPath('userData', userDataPath);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'build/icon.png')
  });

  mainWindow.loadFile('renderer/index.html');

  // DevTools can be opened with F12 or Ctrl+Shift+I
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Get paths for resources
function getResourcePath(relativePath) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  } else {
    return path.join(__dirname, relativePath);
  }
}

// Helper to ensure directory exists
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    // Directory might already exist
  }
}

// =====================================
// IPC Handlers
// =====================================

// Get user data path
ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

// =====================================
// Project Management
// =====================================

ipcMain.handle('save-project', async (event, projectId, data) => {
  try {
    const projectsDir = path.join(app.getPath('userData'), 'projects');
    await ensureDir(projectsDir);

    const filePath = path.join(projectsDir, `${projectId}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true, path: filePath };
  } catch (error) {
    console.error('Error saving project:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-project', async (event, projectId) => {
  try {
    const filePath = path.join(app.getPath('userData'), 'projects', `${projectId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return { success: true, data: JSON.parse(content) };
  } catch (error) {
    console.error('Error loading project:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('list-projects', async () => {
  try {
    const projectsDir = path.join(app.getPath('userData'), 'projects');
    await ensureDir(projectsDir);

    const files = await fs.readdir(projectsDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    // Load project metadata for each file
    const projects = [];
    for (const file of jsonFiles) {
      try {
        const content = await fs.readFile(path.join(projectsDir, file), 'utf-8');
        const data = JSON.parse(content);
        projects.push({
          id: file.replace('.json', ''),
          name: data.name || 'Untitled Project',
          updatedAt: data.updatedAt || null
        });
      } catch (e) {
        // Skip invalid files
      }
    }

    return { success: true, projects };
  } catch (error) {
    console.error('Error listing projects:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-project', async (event, projectId) => {
  try {
    const projectsDir = path.join(app.getPath('userData'), 'projects');
    const filePath = path.join(projectsDir, `${projectId}.json`);
    await fs.unlink(filePath);

    // Also delete any overlay images for this project
    const overlaysDir = path.join(projectsDir, projectId, 'overlays');
    try {
      await fs.rm(overlaysDir, { recursive: true, force: true });
    } catch (e) {
      // Overlays dir might not exist
    }

    return { success: true };
  } catch (error) {
    console.error('Error deleting project:', error);
    return { success: false, error: error.message };
  }
});

// =====================================
// Plat Image Management
// =====================================

ipcMain.handle('import-plat-image', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Plat Image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0];
      const buffer = await fs.readFile(filePath);
      const filename = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();

      let mimeType = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.bmp') mimeType = 'image/bmp';
      else if (ext === '.webp') mimeType = 'image/webp';

      return {
        success: true,
        buffer: buffer.toString('base64'),
        filename,
        mimeType
      };
    }
    return { success: false, canceled: true };
  } catch (error) {
    console.error('Error importing plat image:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-plat-image', async (event, projectId, overlayId, base64Data) => {
  try {
    const overlaysDir = path.join(app.getPath('userData'), 'projects', projectId, 'overlays');
    await ensureDir(overlaysDir);

    const filePath = path.join(overlaysDir, overlayId);
    await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));
    return { success: true, path: filePath };
  } catch (error) {
    console.error('Error saving plat image:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-plat-image', async (event, projectId, overlayId) => {
  try {
    const filePath = path.join(app.getPath('userData'), 'projects', projectId, 'overlays', overlayId);
    const buffer = await fs.readFile(filePath);
    return { success: true, buffer: buffer.toString('base64') };
  } catch (error) {
    console.error('Error loading plat image:', error);
    return { success: false, error: error.message };
  }
});

// =====================================
// GIS Export
// =====================================

ipcMain.handle('export-shapefile', async (event, zipBuffer, defaultName) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Shapefile',
      defaultPath: defaultName + '.zip',
      filters: [
        { name: 'Zip Archive', extensions: ['zip'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      await fs.writeFile(result.filePath, Buffer.from(zipBuffer));
      return { success: true, path: result.filePath };
    }
    return { success: false, canceled: true };
  } catch (error) {
    console.error('Error exporting shapefile:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('export-geojson', async (event, geojsonData, defaultName) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export GeoJSON',
      defaultPath: defaultName + '.geojson',
      filters: [
        { name: 'GeoJSON', extensions: ['geojson', 'json'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      await fs.writeFile(result.filePath, JSON.stringify(geojsonData, null, 2), 'utf-8');
      return { success: true, path: result.filePath };
    }
    return { success: false, canceled: true };
  } catch (error) {
    console.error('Error exporting GeoJSON:', error);
    return { success: false, error: error.message };
  }
});

// =====================================
// Reference Layer Import (Shapefile/GeoJSON)
// =====================================

ipcMain.handle('import-reference-layer', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Reference Layer',
      properties: ['openFile'],
      filters: [
        { name: 'GIS Files', extensions: ['geojson', 'json', 'shp'] },
        { name: 'GeoJSON', extensions: ['geojson', 'json'] },
        { name: 'Shapefile', extensions: ['shp'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0];
      const ext = path.extname(filePath).toLowerCase();
      const filename = path.basename(filePath, ext);

      if (ext === '.shp') {
        // Read shapefile and associated files
        const geojson = await readShapefile(filePath);
        return {
          success: true,
          data: geojson,
          filename,
          type: 'shapefile'
        };
      } else {
        // Read GeoJSON directly
        const content = await fs.readFile(filePath, 'utf-8');
        const geojson = JSON.parse(content);
        return {
          success: true,
          data: geojson,
          filename,
          type: 'geojson'
        };
      }
    }
    return { success: false, canceled: true };
  } catch (error) {
    console.error('Error importing reference layer:', error);
    return { success: false, error: error.message };
  }
});

// Helper function to read shapefile
async function readShapefile(shpPath) {
  const shapefile = require('shapefile');
  const features = [];

  // Open and read the shapefile
  const source = await shapefile.open(shpPath);

  while (true) {
    const result = await source.read();
    if (result.done) break;
    features.push(result.value);
  }

  return {
    type: 'FeatureCollection',
    features
  };
}

// =====================================
// Resources
// =====================================

ipcMain.handle('load-resource', async (event, resourcePath) => {
  try {
    const fullPath = getResourcePath(resourcePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    return { success: true, content };
  } catch (error) {
    console.error('Error loading resource:', error);
    return { success: false, error: error.message };
  }
});

// =====================================
// Settings
// =====================================

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('Error saving settings:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-settings', async () => {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    const content = await fs.readFile(settingsPath, 'utf-8');
    return { success: true, settings: JSON.parse(content) };
  } catch (error) {
    // Return default settings if file doesn't exist
    return {
      success: true,
      settings: {
        defaultDistanceUnit: 'feet',
        defaultBearingFormat: 'quadrant',
        coordinateSystem: 'EPSG:4326',
        closureToleranceRatio: 10000,
        autoSave: true,
        theme: 'light',
        mapStyle: 'day'
      }
    };
  }
});

// ========== Debug Logger IPC Handlers ==========

const LOG_FILE_MAX_SIZE = 1024 * 1024; // 1MB

// Get log file path
function getLogFilePath() {
  return path.join(app.getPath('userData'), 'debug.log');
}

// IPC Handler: Append log entry
ipcMain.handle('append-log', async (event, logLine) => {
  try {
    const logFilePath = getLogFilePath();

    // Check file size and rotate if needed
    try {
      const stats = await fs.stat(logFilePath);
      if (stats.size > LOG_FILE_MAX_SIZE) {
        // Rotate: rename current to .old, start fresh
        const oldPath = logFilePath + '.old';
        try { await fs.unlink(oldPath); } catch {}
        await fs.rename(logFilePath, oldPath);
      }
    } catch {
      // File doesn't exist yet, that's fine
    }

    await fs.appendFile(logFilePath, logLine, 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('Error appending log:', error);
    return { success: false, error: error.message };
  }
});

// IPC Handler: Get all logs
ipcMain.handle('get-logs', async (event, options = {}) => {
  try {
    const logFilePath = getLogFilePath();
    let content = '';

    // Read current log file
    try {
      content = await fs.readFile(logFilePath, 'utf-8');
    } catch {}

    // Also try to read .old file
    try {
      const oldContent = await fs.readFile(logFilePath + '.old', 'utf-8');
      content = oldContent + content;
    } catch {}

    // Parse JSON lines
    const logs = content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(log => log !== null);

    // Apply filters
    let filtered = logs;
    if (options.level) {
      filtered = filtered.filter(l => l.level === options.level);
    }
    if (options.sessionId) {
      filtered = filtered.filter(l => l.sessionId === options.sessionId);
    }

    // Limit and return most recent
    if (options.limit) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  } catch (error) {
    console.error('Error getting logs:', error);
    return [];
  }
});

// IPC Handler: Clear logs
ipcMain.handle('clear-logs', async () => {
  try {
    const logFilePath = getLogFilePath();
    await fs.writeFile(logFilePath, '', 'utf-8');
    try { await fs.unlink(logFilePath + '.old'); } catch {}
    return { success: true };
  } catch (error) {
    console.error('Error clearing logs:', error);
    return { success: false, error: error.message };
  }
});

// IPC Handler: Save log file (for export)
ipcMain.handle('save-log-file', async (event, content, defaultFilename) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultFilename,
      filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }]
    });

    if (!result.canceled && result.filePath) {
      await fs.writeFile(result.filePath, content, 'utf-8');
      return { success: true, path: result.filePath };
    }
    return { success: false, cancelled: true };
  } catch (error) {
    console.error('Error saving log file:', error);
    return { success: false, error: error.message };
  }
});
