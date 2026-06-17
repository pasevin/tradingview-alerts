// macOS-style toggle built on the Radix Switch primitive (accessible, animated).
// Green track when on, white knob — matches the native System Settings switch.
import * as RSwitch from "@radix-ui/react-switch";
import { clsx } from "clsx";
import type { JSX } from "react";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}): JSX.Element {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={clsx(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full",
        "border border-black/5 transition-colors duration-200 ease-out outline-none",
        "focus-visible:ring-2 focus-visible:ring-blue-500/50",
        "disabled:opacity-50",
        checked ? "bg-green-500" : "bg-black/15 dark:bg-white/20",
      )}
    >
      <RSwitch.Thumb
        className={clsx(
          "block h-[18px] w-[18px] rounded-full bg-white shadow-sm",
          "transition-transform duration-200 ease-out will-change-transform",
          "translate-x-[2px] data-[state=checked]:translate-x-[18px]",
        )}
      />
    </RSwitch.Root>
  );
}
