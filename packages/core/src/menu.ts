/**
 * Menu facade. Wraps Tauri's async menu builder behind Glaze's synchronous
 * `Menu.buildFromTemplate(template)` shape so existing tray-menu code ports
 * directly.
 *
 * macOS quirk encoded here: top-level tray items can be silently dropped by the
 * system, so callers are expected to nest real items under a submenu. We keep
 * the template structure faithful and let the Rust side attach it to the tray.
 */
import {
  Menu as TauriMenu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";

export interface MenuItemTemplate {
  label?: string;
  /** SF Symbol-style name kept for source parity; rendered by the tray layer. */
  icon?: string;
  enabled?: boolean;
  type?: "normal" | "separator";
  click?: () => void | Promise<void>;
  submenu?: MenuItemTemplate[];
}

async function buildItem(
  tpl: MenuItemTemplate,
): Promise<MenuItem | PredefinedMenuItem | Submenu> {
  if (tpl.type === "separator") {
    return PredefinedMenuItem.new({ item: "Separator" });
  }
  if (tpl.submenu) {
    const items = await Promise.all(tpl.submenu.map(buildItem));
    return Submenu.new({ text: tpl.label ?? "", items });
  }
  return MenuItem.new({
    text: tpl.label ?? "",
    enabled: tpl.enabled ?? true,
    action: tpl.click ? () => void tpl.click?.() : undefined,
  });
}

export const Menu = {
  /**
   * Async under the hood (Tauri requirement) but named to match the Glaze
   * `buildFromTemplate` call site. Backend code already `await`s menu builds.
   */
  async buildFromTemplate(template: MenuItemTemplate[]): Promise<TauriMenu> {
    const items = await Promise.all(template.map(buildItem));
    return TauriMenu.new({ items });
  },
};
