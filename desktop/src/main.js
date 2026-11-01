const { app, BrowserWindow, protocol, net, shell, session } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

// this makes a fake address (app://studio) so your site runs like it does online
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

// the website files get copied into this folder when the exe is built
const WEB_DIR = path.join(__dirname, "..", "web");

// how long you stay logged in after closing the app (in seconds)
// 60 * 60 * 24 * 30 = 30 days
const STAY_LOGGED_IN_FOR = 60 * 60 * 24 * 30;

// login cookies with no expiry get deleted when the app closes.
// this gives them an expiry date so they get saved to disk instead.
function keepLoggedIn() {
  const cookies = session.defaultSession.cookies;

  cookies.on("changed", (event, cookie, cause, removed) => {
    if (removed) return;
    if (!cookie.session) return;

    const host = cookie.domain.replace(/^\./, "");
    const url = (cookie.secure ? "https://" : "http://") + host + cookie.path;

    const newCookie = {
      url: url,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: Math.floor(Date.now() / 1000) + STAY_LOGGED_IN_FOR
    };

    // only keep the domain if it started with a dot
    if (cookie.domain.startsWith(".")) {
      newCookie.domain = cookie.domain;
    }

    cookies.set(newCookie).catch(() => {});
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1e2327",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadURL("app://studio/index.html");

  // links to other websites open in the normal browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);
    if (filePath === "/") {
      filePath = "/index.html";
    }
    const fullPath = path.normalize(path.join(WEB_DIR, filePath));

    // safety check: never serve anything outside the web folder
    if (!fullPath.startsWith(WEB_DIR)) {
      return new Response("not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(fullPath).toString());
  });

  keepLoggedIn();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// make sure cookies are written to disk before the app closes
app.on("before-quit", () => {
  session.defaultSession.cookies.flushStore().catch(() => {});
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
