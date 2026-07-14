import type { ReactNode } from "react"
import type { User } from "@starbase/core"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { ChevronsUpDown, Gauge, LogOut, Settings } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Avatar } from "../components/avatar.js"
import { StatusDot } from "../components/status-dot.js"

export interface UserMenuProps {
  /** The signed-in user (name / email / avatar). */
  user: User
  /** Open the Settings view. */
  onOpenSettings?: () => void
  /** Open the Usage & limits modal. */
  onOpenUsage?: () => void
  /** Sign out of the app. */
  onSignOut?: () => void
  /** Whether GitHub is connected (green dot on Settings). */
  ghConnected?: boolean
  /** App version, shown at the foot of the menu. */
  version?: string
}

/** First letter of the display name (or email), for the monogram fallback. */
const initialOf = (user: User): string => {
  const base = user.name.trim() || user.email
  return base.length > 0 ? base[0]!.toUpperCase() : "?"
}

const displayNameOf = (user: User): string => user.name.trim() || user.email.split("@")[0] || user.email

function MenuItem({
  icon,
  label,
  onSelect,
  trailing,
  danger = false
}: {
  icon: ReactNode
  label: string
  onSelect: () => void
  trailing?: ReactNode
  danger?: boolean
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] outline-none",
        danger
          ? "text-red data-[highlighted]:bg-red/10"
          : "text-text-body data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
      )}
    >
      <span className={cn("flex-none", danger ? "text-red" : "text-muted-foreground")}>{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing}
    </DropdownMenu.Item>
  )
}

/**
 * The sidebar footer account control: shows the signed-in user (avatar, name,
 * email) and opens a menu with Settings, Usage & limits, and Sign out. Built on
 * Radix DropdownMenu (opens upward from the footer). The former footer icon
 * buttons now live here.
 */
export function UserMenu({
  user,
  onOpenSettings,
  onOpenUsage,
  onSignOut,
  ghConnected = false,
  version
}: UserMenuProps) {
  const displayName = displayNameOf(user)
  const initial = initialOf(user)

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar initial={initial} src={user.image} size={28} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[12.5px] font-semibold text-text-bright">{displayName}</span>
            <span className="truncate text-[11px] text-muted-foreground">{user.email}</span>
          </span>
          <ChevronsUpDown size={14} className="flex-none text-dim" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 flex w-[242px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <Avatar initial={initial} src={user.image} size={32} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[12.5px] font-semibold text-text-bright">{displayName}</span>
              <span className="truncate text-[11px] text-muted-foreground">{user.email}</span>
            </span>
          </div>

          {(onOpenSettings || onOpenUsage) && (
            <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          )}
          {onOpenSettings && (
            <MenuItem
              icon={<Settings size={14} />}
              label="Settings"
              onSelect={onOpenSettings}
              trailing={ghConnected ? <StatusDot tone="bg-green" size={6} glow /> : undefined}
            />
          )}
          {onOpenUsage && (
            <MenuItem icon={<Gauge size={14} />} label="Usage & limits" onSelect={onOpenUsage} />
          )}

          {onSignOut && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
              <MenuItem icon={<LogOut size={14} />} label="Sign out" onSelect={onSignOut} danger />
            </>
          )}

          {version && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
              <span className="px-2.5 py-1 font-mono text-[10.5px] text-dim">Starbase v{version}</span>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
