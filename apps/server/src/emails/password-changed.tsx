/** 05 · Password changed — security confirmation after a change. */
import * as React from "react"
import { Section } from "@react-email/components"
import { EmailShell, Mono, P, MetaBox, SecurityFooter } from "./components.js"
import { color, font, radius } from "./theme.js"

export interface PasswordChangedProps {
  /** The affected account. */
  email: string
  /** When the change happened (human string). */
  when: string
  /** Device string, e.g. "macOS · Chrome 126". */
  device: string
  /** Approximate location, e.g. "Amsterdam, NL". */
  location: string
  /** "Secure account" link for the wasn't-me case. */
  secureUrl: string
}

export const passwordChangedSubject = "Your Starbase password was changed"

export function PasswordChanged({
  email,
  when,
  device,
  location,
  secureUrl
}: PasswordChangedProps) {
  return (
    <EmailShell preview="A quick heads-up on your account." footer={<SecurityFooter />}>
      <table style={{ marginBottom: "12px", borderCollapse: "collapse" }}>
        <tr>
          <td style={{ width: "24px", verticalAlign: "middle" }}>
            <div
              style={{
                width: "24px",
                height: "24px",
                borderRadius: radius.full,
                background: color.tintGreen,
                border: `1px solid ${color.tintGreenBorder}`,
                textAlign: "center",
                lineHeight: "24px",
                fontSize: "14px",
                color: color.green
              }}
            >
              ✓
            </div>
          </td>
          <td style={{ paddingLeft: "9px", verticalAlign: "middle" }}>
            <span
              style={{
                fontSize: "21px",
                fontWeight: 600,
                color: color.heading,
                letterSpacing: "-0.3px",
                fontFamily: font.sans
              }}
            >
              Password updated
            </span>
          </td>
        </tr>
      </table>
      <P style={{ margin: "0 0 20px" }}>
        The password for <Mono>{email}</Mono> was just changed. If that was you, you&apos;re all set —
        nothing else to do.
      </P>
      <Section style={{ marginBottom: "22px" }}>
        <MetaBox
          lineHeight="1.9"
          rows={[
            { label: "when    ", value: when },
            { label: "device  ", value: device },
            { label: "location", value: location }
          ]}
        />
      </Section>
      <table
        style={{
          borderCollapse: "collapse",
          background: color.tintRed,
          border: `1px solid ${color.tintRedBorder}`,
          borderRadius: radius.sm
        }}
      >
        <tr>
          <td style={{ padding: "12px 14px", verticalAlign: "top" }}>
            <table style={{ borderCollapse: "collapse" }}>
              <tr>
                <td style={{ width: "20px", verticalAlign: "top", paddingTop: "1px" }}>
                  <span style={{ fontSize: "15px", color: color.red }}>⚠</span>
                </td>
                <td style={{ paddingLeft: "10px" }}>
                  <P
                    style={{
                      margin: "0 0 10px",
                      fontSize: "13px",
                      lineHeight: 1.45,
                      color: color.body
                    }}
                  >
                    <strong style={{ color: color.heading, fontWeight: 600 }}>Wasn&apos;t you?</strong>{" "}
                    Lock your account and revoke active sessions right away.
                  </P>
                  <a
                    href={secureUrl}
                    style={{
                      display: "inline-block",
                      background: "transparent",
                      color: color.red,
                      fontSize: "13px",
                      fontWeight: 600,
                      textDecoration: "none",
                      padding: "7px 15px",
                      border: `1px solid ${color.tintRedButtonBorder}`,
                      borderRadius: radius.sm,
                      fontFamily: font.sans
                    }}
                  >
                    Secure account
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </EmailShell>
  )
}

PasswordChanged.PreviewProps = {
  email: "you@acme.dev",
  when: "Jul 15, 2026 · 14:32 UTC",
  device: "macOS · Chrome 126",
  location: "Amsterdam, NL",
  secureUrl: "https://app.starbase.dev/security"
} satisfies PasswordChangedProps

export default PasswordChanged
