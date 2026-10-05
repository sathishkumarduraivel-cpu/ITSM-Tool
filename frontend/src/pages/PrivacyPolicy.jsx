import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

const SECTIONS = [
  { id: 'overview', title: 'Overview' },
  { id: 'information-we-collect', title: 'Information we collect' },
  { id: 'how-we-use-it', title: 'How we use it' },
  { id: 'account-security', title: 'Account security' },
  { id: 'sso-directory', title: 'Single sign-on & directory sync' },
  { id: 'email-integration', title: 'Email integration' },
  { id: 'ai-features', title: 'AI-assisted features' },
  { id: 'cookies-storage', title: 'Cookies & local storage' },
  { id: 'retention', title: 'Data retention & deletion' },
  { id: 'sharing', title: 'Data sharing' },
  { id: 'your-rights', title: 'Your rights & choices' },
  { id: 'children', title: "Children's privacy" },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'Contact' },
];

function Section({ id, title, children }) {
  return (
    <section id={id} className="scroll-mt-24 pb-8 mb-8 border-b border-slate-100 dark:border-slate-800 last:border-0">
      <h2 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100 mb-3">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{children}</div>
    </section>
  );
}

// Public and standalone (not wrapped in AppShell/PrivateRoute -- registered
// at top level in App.jsx like /login and /register) so it's reachable
// before signing in, same as the pages that link to it.
export default function PrivacyPolicy() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [active, setActive] = useState(SECTIONS[0].id);

  // Highlights whichever section is currently scrolled into view in the
  // side TOC -- purely cosmetic wayfinding, not navigation logic, so a
  // simple "closest heading above the fold" scan on scroll is enough.
  useEffect(() => {
    const onScroll = () => {
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 140) current = s.id;
      }
      setActive(current);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-20 bg-white/80 dark:bg-slate-900/80 backdrop-blur border-b border-slate-100 dark:border-slate-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link to={user ? '/' : '/login'} className="flex items-center gap-2.5">
            <div className="relative w-8 h-8 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-glow-brand flex items-center justify-center text-white text-xs font-display font-bold">
              IT
            </div>
            <span className="font-display font-bold text-slate-800 dark:text-slate-100">ITSM AI</span>
          </Link>
          <button onClick={() => navigate(-1)} className="btn-secondary text-xs">
            <ArrowLeft size={13} /> Back
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-10">
        <nav className="hidden lg:block sticky top-24 self-start">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">On this page</div>
          <ul className="space-y-1">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className={`block text-sm px-2.5 py-1.5 rounded-lg transition-colors ${
                    active === s.id
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400 font-medium'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                  }`}
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 24 }}>
          <div className="flex items-center gap-2.5 mb-2">
            <ShieldCheck size={20} className="text-brand-600 dark:text-brand-400" />
            <h1 className="text-2xl font-display font-bold text-slate-800 dark:text-slate-100">Privacy Policy</h1>
          </div>
          <p className="text-sm text-slate-400 mb-10">Last updated: September 15, 2026</p>

          <Section id="overview" title="Overview">
            <p>
              ITSM AI is an IT service management application: it helps a workspace track tickets, assets, knowledge base
              articles, and related IT operations for the organization that operates it. This policy explains what
              information the application collects as part of that job, how it's used, and the choices available to you.
            </p>
            <p>
              ITSM AI is deployed and operated by your own organization, not by a shared external vendor — each
              installation is a separate, self-contained instance with its own database. Nothing you enter is sent to a
              central "ITSM AI" company; it stays within the instance your organization runs, except where this policy
              says otherwise (for example, a third-party service your administrator has explicitly connected).
            </p>
          </Section>

          <Section id="information-we-collect" title="Information we collect">
            <p>To provide the service, the application stores:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong className="text-slate-700 dark:text-slate-200">Account information</strong> — your name, email address, and a securely hashed password (never the password itself).</li>
              <li><strong className="text-slate-700 dark:text-slate-200">Workplace profile details</strong> — role, team, employee ID, manager, location, timezone, and language, where your organization has configured or entered them.</li>
              <li><strong className="text-slate-700 dark:text-slate-200">Ticket content</strong> — the tickets, comments, and attachments you submit or that are submitted about you, including anything shared with a support agent.</li>
              <li><strong className="text-slate-700 dark:text-slate-200">Activity and audit records</strong> — key actions (sign-ins, ticket changes, configuration changes) are logged with a timestamp and actor, so administrators can maintain accountability over the system.</li>
              <li><strong className="text-slate-700 dark:text-slate-200">Authentication data</strong> — if your organization enables Google or Microsoft sign-in, or directory sync (LDAP/Active Directory or Microsoft Entra ID), your basic profile (name, email, and, where applicable, department/employee ID) is read from that provider to create or update your account. See <a href="#sso-directory" className="text-brand-600 dark:text-brand-400 hover:underline">Single sign-on &amp; directory sync</a>.</li>
            </ul>
          </Section>

          <Section id="how-we-use-it" title="How we use it">
            <p>Information collected is used to:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Create, route, assign, and resolve tickets, including matching them against your organization's SLA policies and escalation rules.</li>
              <li>Notify you and relevant agents about ticket activity, approvals, and major incidents, by email and in-app notification.</li>
              <li>Authenticate you and enforce the access permissions your administrator has assigned to your role.</li>
              <li>Maintain an audit trail of significant actions, for security and accountability.</li>
              <li>Where your administrator has enabled it, provide AI-assisted features such as ticket summarization and category suggestions — see <a href="#ai-features" className="text-brand-600 dark:text-brand-400 hover:underline">AI-assisted features</a>.</li>
            </ul>
          </Section>

          <Section id="account-security" title="Account security">
            <p>
              Passwords are never stored in plain text — they're hashed with bcrypt, a one-way algorithm designed to
              resist brute-force attacks. If your account has a directly-managed password, only you and the system that
              verifies it ever see it.
            </p>
            <p>
              You can optionally enable two-factor authentication (an authenticator app, using the standard TOTP
              protocol) from your profile. If you do, a set of one-time recovery codes is generated and shown to you
              exactly once at enrollment — only a one-way hash of each code is stored afterward, the same way your
              password is, so recovering a lost authenticator never requires anyone, including an administrator, to
              "look up" your codes.
            </p>
            <p>
              Signing in issues a session token that your browser stores locally and sends with each request; it expires
              automatically and is discarded when you sign out. See <a href="#cookies-storage" className="text-brand-600 dark:text-brand-400 hover:underline">Cookies &amp; local storage</a>.
            </p>
          </Section>

          <Section id="sso-directory" title="Single sign-on & directory sync">
            <p>
              If your administrator enables "Sign in with Google" or "Sign in with Microsoft," those providers are
              configured by your own organization (using its own app registration and credentials) — not a connection
              this application controls centrally. Signing in that way shares your basic profile (name, email) from that
              provider with this application, governed by that provider's own privacy policy for the authentication step
              itself.
            </p>
            <p>
              If your administrator connects an external directory (an on-premises Active Directory/LDAP server, or
              Microsoft Entra ID via Microsoft Graph) for automatic provisioning, the application periodically reads that
              directory's user list to keep accounts, team assignments, and active/inactive status up to date — including
              deactivating an account here if it's removed or disabled in the source directory.
            </p>
          </Section>

          <Section id="email-integration" title="Email integration">
            <p>
              If your administrator connects an outbound mailbox (SMTP credentials, or a Microsoft 365/Outlook mailbox
              via Microsoft Graph), ticket notifications are sent from that address. If inbound email-to-ticket is also
              enabled, messages sent to that mailbox are read to create or update tickets. Where the receiving mail
              server provides sender-authentication results (SPF/DKIM/DMARC), those are checked before a reply is
              attributed to an existing requester — an unverified sender is flagged rather than trusted outright.
            </p>
          </Section>

          <Section id="ai-features" title="AI-assisted features">
            <p>
              Some features — ticket summarization, sentiment detection, category suggestions, and the self-service
              chatbot — work by sending relevant ticket text to an AI provider. This only happens if your administrator
              has configured one (for example, an OpenAI, Anthropic, Azure OpenAI, or self-hosted model endpoint, using
              credentials your organization supplies), and only for the specific ticket or question being processed at
              that moment. That provider's own privacy and data-handling terms apply to what it does with the text it
              receives. If no AI provider is configured, none of these features send any data anywhere.
            </p>
          </Section>

          <Section id="cookies-storage" title="Cookies & local storage">
            <p>
              This application does not use third-party advertising or tracking cookies. Your browser's local storage is
              used to keep you signed in (your session token) and to remember interface preferences such as light/dark
              mode and display language. This data stays on your device, is never sold or shared, and is cleared when
              you sign out.
            </p>
          </Section>

          <Section id="retention" title="Data retention & deletion">
            <p>
              Your data is retained for as long as your account is active in your organization's workspace. Tickets and
              audit history are generally preserved even after an account is deactivated — the same way a paper filing
              system keeps closed case records — so that reporting and accountability stay accurate over time; records
              are not silently altered or deleted as accounts change.
            </p>
            <p>
              An administrator can deactivate or remove your account at any time, which revokes your access; this does
              not retroactively remove tickets or comments already on record, since those may be relied on by other
              people's ticket history.
            </p>
          </Section>

          <Section id="sharing" title="Data sharing">
            <p>We don't sell personal data. Information is shared only:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>With the third-party services your administrator has explicitly configured for this workspace — an AI provider, an SSO or directory provider, an email provider, or an external ticketing platform (such as Jira, ServiceNow, or Freshservice) that this instance is set up to sync with.</li>
              <li>Among your organization's own agents and administrators, to the extent their role permits, as part of normal service desk operation.</li>
              <li>Where required to comply with applicable law.</li>
            </ul>
          </Section>

          <Section id="your-rights" title="Your rights & choices">
            <p>
              You can review and update your own profile information (name, email, language, location, timezone) at any
              time from your account menu. For anything beyond that — correcting other stored information, exporting
              your data, or requesting deletion — contact your workspace administrator, since they control the
              underlying instance and can act on that request directly.
            </p>
          </Section>

          <Section id="children" title="Children's privacy">
            <p>
              ITSM AI is a workplace IT service management tool, intended for use by employees, contractors, and other
              authorized users of an organization. It is not directed at, and should not be used by, children.
            </p>
          </Section>

          <Section id="changes" title="Changes to this policy">
            <p>
              If this policy changes, the "Last updated" date at the top of this page will change accordingly. Since
              this application is operated by your own organization, your administrator may also supplement this policy
              with additional terms specific to your organization.
            </p>
          </Section>

          <Section id="contact" title="Contact">
            <p>
              For questions about how your data is handled in this instance of ITSM AI, contact your workspace
              administrator or IT department — they operate this installation and are best placed to answer
              instance-specific questions.
            </p>
          </Section>
        </motion.div>
      </div>
    </div>
  );
}
