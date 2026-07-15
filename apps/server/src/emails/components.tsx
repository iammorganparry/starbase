/**
 * Shared building blocks for the Starbase email suite — the brand-marked card
 * shell, primary button, footers, and the mono metadata box. Every template is
 * assembled from these so the One Dark Pro chrome stays identical across the
 * suite (see Email Suite.dc.html). All styling is inline for email-client safety.
 */
import * as React from "react"
import {
  Body,
  Column,
  Container,
  Font,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text
} from "@react-email/components"
import { color, font, radius } from "./theme.js"

const MONO = font.mono

/** Inline monospace span (emails, IDs, addresses). */
export function Mono({
  children,
  c = color.heading,
  size = "13px"
}: {
  children: React.ReactNode
  c?: string
  size?: string
}) {
  return (
    <span style={{ fontFamily: MONO, fontSize: size, color: c }}>{children}</span>
  )
}

/** The ✦ + wordmark that heads every email body. */
function BrandHeader() {
  return (
    <Section style={{ padding: "26px 34px 0" }}>
      <Row>
        <Column style={{ width: "28px", verticalAlign: "middle" }}>
          <div
            style={{
              width: "28px",
              height: "28px",
              borderRadius: radius.sm,
              background: color.tintBlue,
              border: `1px solid ${color.tintBlueBorder}`,
              textAlign: "center",
              lineHeight: "28px",
              fontFamily: MONO,
              fontSize: "15px",
              fontWeight: 600,
              color: color.accent
            }}
          >
            ✦
          </div>
        </Column>
        <Column style={{ paddingLeft: "10px", verticalAlign: "middle" }}>
          <span
            style={{
              fontSize: "15px",
              fontWeight: 600,
              color: color.heading,
              letterSpacing: "-0.2px"
            }}
          >
            Starbase
          </span>
        </Column>
      </Row>
    </Section>
  )
}

/** Solid accent CTA button (renders as a bulletproof anchor). */
export function PrimaryButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      style={{
        display: "inline-block",
        background: color.accent,
        color: color.accentContrast,
        fontFamily: font.sans,
        fontSize: "14px",
        fontWeight: 600,
        textDecoration: "none",
        padding: "11px 24px",
        borderRadius: radius.md
      }}
    >
      {children}
    </a>
  )
}

/** Full-width hairline divider matching the design's inset rules. */
export function Divider() {
  return <Hr style={{ borderColor: color.borderStrong, borderWidth: "0.5px", margin: "22px 0" }} />
}

/** Sunken mono metadata block (request context, change log). */
export function MetaBox({
  rows,
  lineHeight = "1.7"
}: {
  rows: Array<{ label: string; value: React.ReactNode }>
  lineHeight?: string
}) {
  return (
    <div
      style={{
        padding: "12px 14px",
        background: color.sunken,
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        fontFamily: MONO,
        fontSize: "12px",
        lineHeight,
        color: color.secondary
      }}
    >
      {rows.map((r, i) => (
        <div key={i}>
          <span style={{ color: color.faint }}>{r.label}</span> {r.value}
        </div>
      ))}
    </div>
  )
}

const FOOTER_TAGLINE = "Starbase — the agent harness for your terminal."

/** Security footer — no marketing links (verify, magic link, reset, changed). */
export function SecurityFooter() {
  return (
    <Section
      style={{
        padding: "18px 34px",
        borderTop: `1px solid ${color.borderStrong}`,
        background: "rgba(0,0,0,0.14)"
      }}
    >
      <Text style={{ margin: "0 0 4px", fontSize: "11.5px", color: color.caption }}>
        {FOOTER_TAGLINE}
      </Text>
      <Text style={{ margin: 0, fontSize: "11px", color: color.faint }}>
        This is a security email tied to your account. © 2026 Starbase Labs · 2261 Market St, San
        Francisco, CA
      </Text>
    </Section>
  )
}

/** Marketing footer — manage/unsubscribe links (welcome, team invite). */
export function MarketingFooter({
  to,
  showUnsubscribe = true
}: {
  to: string
  showUnsubscribe?: boolean
}) {
  const linkStyle = { color: color.muted, textDecoration: "none" as const }
  return (
    <Section
      style={{
        padding: "18px 34px",
        borderTop: `1px solid ${color.borderStrong}`,
        background: "rgba(0,0,0,0.14)"
      }}
    >
      <Text style={{ margin: "0 0 4px", fontSize: "11.5px", color: color.caption }}>
        {FOOTER_TAGLINE}
      </Text>
      <Text style={{ margin: 0, fontSize: "11px", color: color.faint }}>
        Sent to {to} ·{" "}
        <Link href="#" style={linkStyle}>
          Manage email preferences
        </Link>
        {showUnsubscribe ? (
          <>
            {" · "}
            <Link href="#" style={linkStyle}>
              Unsubscribe
            </Link>
          </>
        ) : null}{" "}
        · © 2026 Starbase Labs
      </Text>
    </Section>
  )
}

/** Standard body text paragraph. */
export function P({
  children,
  style
}: {
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <Text
      style={{
        margin: "0 0 22px",
        fontSize: "14.5px",
        lineHeight: 1.6,
        color: color.body,
        fontFamily: font.sans,
        ...style
      }}
    >
      {children}
    </Text>
  )
}

/** Body heading (h1 in the email, 21px). */
export function H1({ children }: { children: React.ReactNode }) {
  return (
    <Heading
      as="h1"
      style={{
        margin: "0 0 12px",
        fontSize: "21px",
        fontWeight: 600,
        color: color.heading,
        letterSpacing: "-0.3px",
        fontFamily: font.sans
      }}
    >
      {children}
    </Heading>
  )
}

export interface EmailShellProps {
  /** Inbox preview / preheader line. */
  preview: string
  /** Card body (headline, copy, CTA, …). */
  children: React.ReactNode
  /** Footer slot — <SecurityFooter/> or <MarketingFooter/>. */
  footer: React.ReactNode
}

/**
 * The outer email frame: fonts, dark page background, and the 560px brand-marked
 * card with the ✦ header, a content region, and a footer.
 */
export function EmailShell({ preview, children, footer }: EmailShellProps) {
  return (
    <Html lang="en">
      <Head>
        <Font
          fontFamily="Hanken Grotesk"
          fallbackFontFamily="Helvetica"
          webFont={{
            url: "https://fonts.gstatic.com/s/hankengrotesk/v11/ieVq2YZDLWuGJpnzaiwFXS9tYuMLLg.woff2",
            format: "woff2"
          }}
          fontWeight={400}
          fontStyle="normal"
        />
        <meta name="color-scheme" content="dark" />
        <meta name="supported-color-schemes" content="dark" />
      </Head>
      <Preview>{preview}</Preview>
      <Body
        style={{
          margin: 0,
          background: color.pageBg,
          fontFamily: font.sans,
          color: color.body,
          padding: "32px 12px"
        }}
      >
        <Container
          style={{
            maxWidth: "560px",
            margin: "0 auto",
            background: color.card,
            border: `1px solid ${color.border}`,
            borderRadius: radius.lg,
            overflow: "hidden"
          }}
        >
          <BrandHeader />
          <Section style={{ padding: "22px 34px 30px" }}>{children}</Section>
          {footer}
        </Container>
      </Body>
    </Html>
  )
}
