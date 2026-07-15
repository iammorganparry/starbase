/** 06 · Team invite — join a teammate's workspace. */
import * as React from "react"
import { Section } from "@react-email/components"
import { EmailShell, H1, Mono, P, MarketingFooter, PrimaryButton } from "./components.js"
import { color, font, radius } from "./theme.js"

export interface TeamInviteProps {
  /** Who sent the invite (display name). */
  inviterName: string
  /** Inviter's email (shown in mono). */
  inviterEmail: string
  /** Workspace / team name. */
  teamName: string
  /** Single-letter avatar glyph for the workspace. */
  teamInitial: string
  /** Roster summary line, e.g. "6 members · 12 active sessions". */
  roster: string
  /** Role the invitee will hold, e.g. "Member". */
  role: string
  /** Accept-invite link. */
  acceptUrl: string
  /** Recipient (footer). */
  email: string
}

export const teamInviteSubject = (inviterName: string, teamName: string): string =>
  `${inviterName} invited you to ${teamName} on Starbase`

export function TeamInvite({
  inviterName,
  inviterEmail,
  teamName,
  teamInitial,
  roster,
  role,
  acceptUrl,
  email
}: TeamInviteProps) {
  return (
    <EmailShell
      preview="Join your team's workspace."
      footer={<MarketingFooter to={email} showUnsubscribe={false} />}
    >
      <H1>You&apos;ve been invited</H1>
      <P style={{ margin: "0 0 20px" }}>
        <strong style={{ color: color.heading, fontWeight: 600 }}>{inviterName}</strong>{" "}
        <Mono size="12.5px" c={color.muted}>
          ({inviterEmail})
        </Mono>{" "}
        added you to the <strong style={{ color: color.heading, fontWeight: 600 }}>{teamName}</strong>{" "}
        workspace. Accept to see the team&apos;s sessions, repos, and pull requests.
      </P>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          background: color.sunken,
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          marginBottom: "24px"
        }}
      >
        <tr>
          <td style={{ padding: "14px 16px", width: "40px", verticalAlign: "middle" }}>
            <div
              style={{
                width: "40px",
                height: "40px",
                borderRadius: radius.md,
                background: color.tintPurple,
                border: `1px solid ${color.tintPurpleBorder}`,
                textAlign: "center",
                lineHeight: "40px",
                fontSize: "17px",
                fontWeight: 700,
                color: color.purple
              }}
            >
              {teamInitial}
            </div>
          </td>
          <td style={{ padding: "14px 0", verticalAlign: "middle" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: color.heading }}>{teamName}</div>
            <div style={{ fontFamily: font.mono, fontSize: "12px", color: color.secondary }}>
              {roster}
            </div>
          </td>
          <td style={{ padding: "14px 16px", verticalAlign: "middle", textAlign: "right" }}>
            <span
              style={{
                fontSize: "11.5px",
                color: color.caption,
                padding: "3px 9px",
                border: `1px solid ${color.border}`,
                borderRadius: radius.xs,
                whiteSpace: "nowrap"
              }}
            >
              {role}
            </span>
          </td>
        </tr>
      </table>
      <Section>
        <PrimaryButton href={acceptUrl}>Accept invite</PrimaryButton>
      </Section>
      <P style={{ margin: "20px 0 0", fontSize: "12.5px", lineHeight: 1.45, color: color.caption }}>
        This invite expires in 7 days. Not expecting it? Just ignore this email.
      </P>
    </EmailShell>
  )
}

TeamInvite.PreviewProps = {
  inviterName: "dan",
  inviterEmail: "dan@acme.dev",
  teamName: "Acme",
  teamInitial: "A",
  roster: "6 members · 12 active sessions",
  role: "Member",
  acceptUrl: "https://app.starbase.dev/invite/accept?t=inv_9f2c",
  email: "you@acme.dev"
} satisfies TeamInviteProps

export default TeamInvite
