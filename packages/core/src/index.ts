/**
 * `@tvalert/core` — a Glaze-shaped facade over Tauri 2.
 *
 * The desktop backend imports the same symbol names it used under Glaze
 * (`app`, `Tray`, `Menu`, `Notification`, `ipcMain`), so application logic stays
 * framework-agnostic and we are never locked into a single runtime again.
 */
export { app } from "./app.js";
export { Tray } from "./tray.js";
export { Menu, type MenuItemTemplate } from "./menu.js";
export { Notification, type NotificationOptions } from "./notification.js";
export { ipcMain } from "./ipc.js";

// Re-export the wire protocol so backend code has one import surface.
export * from "@tvalert/protocol";
