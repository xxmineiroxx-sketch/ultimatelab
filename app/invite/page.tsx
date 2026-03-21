'use client'

import { useEffect, useMemo, useState } from 'react'

const CF_URL = 'https://ultimatelabs.pages.dev'

interface InviteLinks {
  landing?: string
  openApp?: string
  ios?: string
  android?: string
  desktop?: string
}

interface InviteData {
  ok?: boolean
  token: string
  orgName: string
  name: string
  email: string
  phone: string
  contactHint?: string
  status: 'pending' | 'accepted' | 'registered' | string
  createdAt?: string | null
  acceptedAt?: string | null
  registeredAt?: string | null
  downloadLinks?: InviteLinks
}

const DEFAULT_LINKS: InviteLinks = {
  ios: 'https://apps.apple.com/app/ultimate-playback',
  android: 'https://play.google.com/store/apps/details?id=com.ultimatemusician.playback',
  desktop: 'https://www.ultimatelabs.co/portal',
}

function formatDate(value?: string | null) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

export default function InvitePage() {
  const [data, setData] = useState<InviteData | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') || ''
    if (!token) {
      setNotFound(true)
      setLoading(false)
      return
    }

    fetch(`${CF_URL}/sync/invite/resolve?token=${encodeURIComponent(token)}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Invite not found')
        }
        return response.json()
      })
      .then((payload) => setData(payload))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [])

  const isAccepted = data?.status === 'accepted' || data?.status === 'registered'
  const links = useMemo(
    () => ({ ...DEFAULT_LINKS, ...(data?.downloadLinks || {}) }),
    [data?.downloadLinks],
  )

  const handleAccept = async () => {
    if (!data?.token) return
    setAccepting(true)
    setErrorMessage('')
    try {
      const response = await fetch(`${CF_URL}/sync/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: data.token }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Could not accept this invitation.')
      }
      setData(payload)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not accept this invitation.',
      )
    } finally {
      setAccepting(false)
    }
  }

  const openApp = () => {
    if (links.openApp) {
      window.location.href = links.openApp
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[#020617] text-white flex items-center justify-center px-6">
        <div className="text-center">
          <div className="mx-auto mb-6 h-20 w-20 rounded-full border border-indigo-400/30 bg-indigo-500/10 flex items-center justify-center text-4xl animate-pulse">
            ✉️
          </div>
          <h1 className="text-2xl font-bold mb-2">Loading invitation</h1>
          <p className="text-slate-400">Checking your team invitation now…</p>
        </div>
      </main>
    )
  }

  if (notFound || !data) {
    return (
      <main className="min-h-screen bg-[#020617] text-white flex items-center justify-center px-6 py-16">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-6 h-24 w-24 rounded-full border border-rose-500/20 bg-rose-500/10 flex items-center justify-center text-5xl">
            ⚠️
          </div>
          <h1 className="text-3xl font-black mb-4">Invitation not found</h1>
          <p className="text-slate-400 leading-7">
            This invite link is invalid, expired, or has already been removed.
            Ask your church or organization admin to send a new invitation.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#020617] text-white overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.2),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.12),transparent_28%)]" />

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-6 py-12 lg:px-10">
        <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="rounded-[32px] border border-slate-800 bg-slate-950/80 p-8 shadow-[0_30px_80px_rgba(2,6,23,0.45)] backdrop-blur">
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-xs font-extrabold uppercase tracking-[0.24em] text-indigo-300">
              Ultimate Playback Invite
            </div>

            <div className="mb-8">
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-emerald-300/80">
                {data.orgName}
              </p>
              <h1 className="mt-3 text-4xl font-black leading-tight md:text-5xl">
                {isAccepted ? 'You are in.' : 'You have been invited to join the team.'}
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-8 text-slate-300 md:text-lg">
                {data.name ? `Hi ${data.name}, ` : ''}
                {isAccepted
                  ? 'your invitation is active. Download or open Ultimate Playback, register with your invited contact info, and complete the 6-digit email confirmation step.'
                  : 'accept this invitation to connect with your church or organization on Ultimate Playback. Once accepted, you will get the app links and the registration handoff immediately.'}
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
                <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-slate-500">
                  Register With
                </p>
                <p className="mt-3 text-2xl font-bold text-white">
                  {data.contactHint || data.email || data.phone || 'Your invited contact'}
                </p>
                <p className="mt-3 text-sm leading-7 text-slate-400">
                  Use the same email or phone from your invitation. Account verification is protected by a 6-digit confirmation code sent by email.
                </p>
              </div>

              <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
                <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-slate-500">
                  Status
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <span
                    className={cx(
                      'inline-flex rounded-full px-3 py-1 text-xs font-extrabold uppercase tracking-[0.18em]',
                      data.status === 'registered'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : isAccepted
                          ? 'bg-sky-500/20 text-sky-300'
                          : 'bg-amber-500/20 text-amber-300',
                    )}
                  >
                    {data.status === 'registered'
                      ? 'Registered'
                      : isAccepted
                        ? 'Accepted'
                        : 'Pending'}
                  </span>
                  {data.acceptedAt && (
                    <span className="text-sm text-slate-500">
                      Accepted {formatDate(data.acceptedAt)}
                    </span>
                  )}
                </div>
                {data.registeredAt && (
                  <p className="mt-3 text-sm leading-7 text-slate-400">
                    This invite already completed registration on {formatDate(data.registeredAt)}.
                    You can open the app and sign in now.
                  </p>
                )}
              </div>
            </div>

            {!isAccepted ? (
              <div className="mt-8 rounded-3xl border border-indigo-500/20 bg-indigo-500/10 p-6">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-white">Accept your invitation</h2>
                    <p className="mt-2 max-w-xl text-sm leading-7 text-indigo-100/80">
                      This confirms that you want to join {data.orgName} in Ultimate Playback. Right after that, the app download and registration links will appear here.
                    </p>
                  </div>
                  <button
                    onClick={handleAccept}
                    disabled={accepting}
                    className="rounded-2xl bg-white px-6 py-4 text-sm font-extrabold uppercase tracking-[0.18em] text-slate-950 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {accepting ? 'Accepting…' : 'Accept Invitation'}
                  </button>
                </div>
                {errorMessage && (
                  <p className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                    {errorMessage}
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-8">
                <div className="mb-5 flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/20 text-2xl">
                    ✅
                  </div>
                  <div>
                    <h2 className="text-2xl font-black">Download or open the app</h2>
                    <p className="text-sm leading-7 text-slate-400">
                      Once you finish registration, your team will automatically be notified that you are ready to be assigned.
                    </p>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <button
                    onClick={openApp}
                    className="rounded-3xl border border-indigo-400/40 bg-indigo-500/20 p-5 text-left transition hover:border-indigo-300 hover:bg-indigo-500/25"
                  >
                    <div className="text-3xl">🚀</div>
                    <p className="mt-4 text-lg font-bold">Open App</p>
                    <p className="mt-2 text-sm leading-6 text-indigo-100/80">
                      If Ultimate Playback is already installed, jump straight into registration.
                    </p>
                  </button>

                  <a
                    href={links.ios}
                    className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 transition hover:border-slate-700 hover:bg-slate-900"
                  >
                    <div className="text-3xl"></div>
                    <p className="mt-4 text-lg font-bold">iPhone / iPad</p>
                    <p className="mt-2 text-sm leading-6 text-slate-400">
                      Download Ultimate Playback from the App Store.
                    </p>
                  </a>

                  <a
                    href={links.android}
                    className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 transition hover:border-slate-700 hover:bg-slate-900"
                  >
                    <div className="text-3xl">▶</div>
                    <p className="mt-4 text-lg font-bold">Android</p>
                    <p className="mt-2 text-sm leading-6 text-slate-400">
                      Install the Android build from Google Play.
                    </p>
                  </a>

                  <a
                    href={links.desktop}
                    className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 transition hover:border-slate-700 hover:bg-slate-900"
                  >
                    <div className="text-3xl">🖥️</div>
                    <p className="mt-4 text-lg font-bold">Mac / Desktop</p>
                    <p className="mt-2 text-sm leading-6 text-slate-400">
                      Open the desktop portal to manage your account from a larger screen.
                    </p>
                  </a>
                </div>
              </div>
            )}
          </section>

          <aside className="rounded-[32px] border border-slate-800 bg-slate-950/70 p-8 shadow-[0_20px_60px_rgba(2,6,23,0.38)] backdrop-blur">
            <div className="mb-8 flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-900 text-3xl shadow-inner shadow-slate-950">
                🎵
              </div>
              <div>
                <p className="text-xs font-extrabold uppercase tracking-[0.22em] text-slate-500">
                  Next Steps
                </p>
                <h2 className="mt-1 text-2xl font-black">From invite to ready-to-assign</h2>
              </div>
            </div>

            <div className="space-y-4">
              {[
                {
                  step: '1',
                  title: 'Accept the invitation',
                  body: 'This confirms you want to join the team workspace for this church or organization.',
                },
                {
                  step: '2',
                  title: 'Download or open Ultimate Playback',
                  body: 'Use the iPhone, Android, or desktop link after acceptance. If the app is installed already, use Open App.',
                },
                {
                  step: '3',
                  title: 'Create your account',
                  body: 'Register with the same email or phone used on your invitation so your team profile links correctly.',
                },
                {
                  step: '4',
                  title: 'Enter the confirmation code',
                  body: 'A 6-digit verification code will be emailed to you to protect your account.',
                },
                {
                  step: '5',
                  title: 'Your team gets notified',
                  body: 'As soon as registration finishes, the admin dashboard is notified that you are ready for assignments.',
                },
              ].map((item) => (
                <div
                  key={item.step}
                  className="rounded-3xl border border-slate-800 bg-slate-900/60 p-5"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/15 text-sm font-black text-indigo-300">
                      {item.step}
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-white">{item.title}</h3>
                      <p className="mt-2 text-sm leading-7 text-slate-400">{item.body}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-3xl border border-emerald-500/20 bg-emerald-500/10 p-5">
              <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-emerald-300/90">
                Team Status
              </p>
              <p className="mt-3 text-sm leading-7 text-emerald-100/85">
                {isAccepted
                  ? 'Your invitation is active. Finish account registration in Ultimate Playback and your team will see that you are ready to assign.'
                  : 'Accept the invitation first. The app links and registration handoff unlock immediately after that step.'}
              </p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}
