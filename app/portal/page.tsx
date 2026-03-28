'use client'
import { useState, useEffect, useCallback, useRef } from 'react'

const PORTAL_API_BASE = '/portal-api'
const DEVICE_KEY = '@um_portal_device_id'
async function api(path: string, opts: RequestInit = {}) {
  const headers = new Headers(opts.headers as HeadersInit | undefined)
  if (opts.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  headers.set('x-requested-by', 'web-portal')
  const r = await fetch(`${PORTAL_API_BASE}/${path}`, {
    ...opts,
    credentials: 'same-origin',
    headers,
  })
  const data = await r.json().catch(() => ({ ok: r.ok }))
  if (
    r.status === 401
    && path !== 'auth/login'
    && path !== 'auth/register'
    && path !== 'auth/verify'
    && path !== 'auth/resend'
    && path !== 'auth/forgot-password'
    && path !== 'auth/reset-password'
    && path !== 'auth/session'
    && typeof window !== 'undefined'
  ) {
    window.dispatchEvent(new Event('portal-auth-expired'))
  }
  if (!r.ok && !data.error) data.error = `Request failed (${r.status})`
  return data
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface Session  { email: string; name: string; role: string; orgName: string; branchCity: string }
interface Song     { id: string; title: string; artist?: string; key?: string; bpm?: number; timeSig?: string; lyrics?: string; chordChart?: string; latestStemsJob?: { result?: { stems?: Record<string,string> } } }
interface Person   { id: string; name: string; email?: string; phone?: string; roles?: string[]; photo_url?: string }
interface Service  { id: string; title?: string; name?: string; date?: string; service_date?: string; type?: string; status?: string }
interface PlanSong { songId: string; title: string; key?: string; transposedKey?: string; artist?: string; order?: number }
interface Member   { personId?: string; id?: string; name: string; roles?: string[]; email?: string }
interface Plan     { songs: PlanSong[]; team: Member[]; notes?: string }
interface VAPart   { personId?: string; name?: string; key?: string; notes?: string }
interface VA       { [songId: string]: { soprano?: VAPart; alto?: VAPart; tenor?: VAPart; bass?: VAPart } }
interface LibData  {
  songs: Record<string, Song>
  people: Person[]
  services: Service[]
  plans: Record<string, Plan>
  vocalAssignments: Record<string, VA>
  blockouts: Array<{ id: string; email: string; date: string; reason?: string; name?: string }>
}

const PARTS        = ['soprano','alto','tenor','bass'] as const
const KEY_OPTIONS  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B','Cm','Dm','Em','Fm','Gm','Am','Bm']
const SVC_TYPES    = ['standard','youth','communion','easter','christmas','conference','rehearsal']
const SVC_ICONS: Record<string,string> = { standard:'🕊️',youth:'⚡',communion:'🍷',easter:'✨',christmas:'⭐',conference:'🎙️',rehearsal:'🔁' }
const ORG_ROLE_LABELS: Record<string,string> = { owner:'Organization Owner', admin:'Admin', worship_leader:'Worship Leader' }
const ORG_ROLE_COLORS: Record<string,string>  = { owner:'bg-yellow-500/20 text-yellow-300 border-yellow-500/40', admin:'bg-amber-500/20 text-amber-400 border-amber-500/30', worship_leader:'bg-purple-500/20 text-purple-400 border-purple-500/30' }
const MONTH_NAMES  = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAY_NAMES    = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const ROLE_OPTIONS_LIST = ['worship leader','lead vocal','background vocal','guitar','bass','keys','drums','violin','trumpet','saxophone','flute','sound tech','projection','other']
const STEM_COLORS: Record<string,string> = { vocals:'#EC4899',drums:'#14B8A6',bass:'#3B82F6',keys:'#8B5CF6',guitar:'#F97316',other:'#EAB308' }
const AVATAR_COLORS = ['bg-indigo-600','bg-purple-600','bg-pink-600','bg-teal-600','bg-amber-600','bg-blue-600']

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeId()   { return Math.random().toString(36).slice(2,10) }
function initials(n: string) { return (n||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) }
function fmtDate(d?: string) { if (!d) return '—'; try { return new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) } catch { return d } }
function avatarColor(n: string) { return AVATAR_COLORS[n.charCodeAt(0)%AVATAR_COLORS.length] }

const KEY_COLORS: Record<string,string> = { C:'#6366F1',D:'#8B5CF6',E:'#EC4899',F:'#F59E0B',G:'#10B981',A:'#3B82F6',B:'#EF4444' }
function keyColor(k?: string) { return KEY_COLORS[(k||'C').charAt(0).toUpperCase()] || '#6B7280' }

function buildSession(data: Partial<Session> & Record<string, unknown>): Session {
  return {
    email: String(data.email || '').trim().toLowerCase(),
    name: String(data.name || data.email || '').trim(),
    role: String(data.role || 'member').trim(),
    orgName: String(data.orgName || '').trim(),
    branchCity: String(data.branchCity || '').trim(),
  }
}

function getPortalDeviceId() {
  if (typeof window === 'undefined') return ''
  try {
    let deviceId = localStorage.getItem(DEVICE_KEY) || ''
    if (!deviceId) {
      const random =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `portal_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
      deviceId = random
      localStorage.setItem(DEVICE_KEY, deviceId)
    }
    return deviceId
  } catch {
    return ''
  }
}

// ── Auto-detect metadata from chart text ─────────────────────────────────────
function extractMetaFromChart(text: string) {
  const bpm = text.match(/\b(\d{2,3})\s*(?:BPM|bpm)\b|(?:BPM|Tempo)[:\s]+(\d{2,3})/i)
  const key = text.match(/(?:Tom|Key|Tonalidade|Chave)[:\s]+([A-G][#b]?(?:\/[A-G][#b]?)?(?:\s*m(?:in)?)?)/i)
  const ts  = text.match(/\b([2-9]\/[2-9](?:6?8?)?)\b/)
  return {
    bpm:     bpm ? parseInt(bpm[1]||bpm[2], 10) : null,
    key:     key ? key[1].split('/')[0].trim().replace(/\s*min$/i,'m') : null,
    timeSig: ts  ? ts[1] : null,
  }
}

// ── Chord renderer ────────────────────────────────────────────────────────────
const CHORD_RE = /^[A-G][b#]?(maj|min|m|M|sus|aug|dim|add|dom)?\d*(\/[A-G][b#]?)?$/
function isChordToken(t: string) { return CHORD_RE.test(t.replace(/[()]/g,'')) }
function classifyLine(line: string): 'empty'|'section'|'chords'|'lyric' {
  if (!line.trim()) return 'empty'
  if (/^\[.+\]$/.test(line.trim()) || /^(verse|chorus|bridge|pre-chorus|intro|outro|tag|vamp|interlude)\s*\d*$/i.test(line.trim())) return 'section'
  const tokens = line.trim().split(/\s+/)
  return tokens.filter(isChordToken).length / tokens.length >= 0.55 ? 'chords' : 'lyric'
}
function ChordChart({ text }: { text: string }) {
  if (!text) return <p className="text-gray-500 italic text-sm">No chord chart or lyrics available.</p>
  return (
    <div className="font-mono text-sm leading-relaxed whitespace-pre-wrap">
      {text.split('\n').map((line, i) => {
        const t = classifyLine(line)
        if (t==='empty')   return <div key={i} className="h-3" />
        if (t==='section') return <div key={i} className="text-gray-400 uppercase text-xs tracking-widest mt-4 mb-1 font-bold">{line}</div>
        if (t==='chords')  return <div key={i} className="text-yellow-400 font-bold tracking-wide mb-0.5">{line}</div>
        return <div key={i} className="text-gray-100">{line}</div>
      })}
    </div>
  )
}

// ── Shared UI ─────────────────────────────────────────────────────────────────
function Avatar({ name, size=36 }: { name:string; size?:number }) {
  return (
    <div className={`rounded-full ${avatarColor(name)} flex items-center justify-center shrink-0 font-bold text-white select-none`}
         style={{ width:size, height:size, fontSize:size*0.36 }}>
      {initials(name)}
    </div>
  )
}
function RoleBadge({ role }: { role:string }) {
  const label = ORG_ROLE_LABELS[role] || role
  const cls   = ORG_ROLE_COLORS[role] || 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  return <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cls}`}>{label}</span>
}
function KeyBadge({ k }: { k?:string }) {
  if (!k) return null
  const c = keyColor(k)
  return <span className="text-xs px-2 py-0.5 rounded-full font-mono border" style={{ color:c, borderColor:c+'60', backgroundColor:c+'15' }}>{k}</span>
}
function Modal({ title, onClose, children, wide }: { title:string; onClose:()=>void; children:React.ReactNode; wide?:boolean }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className={`bg-[#0f172a] border border-gray-800 rounded-2xl flex flex-col max-h-[90vh] ${wide?'w-full max-w-3xl':'w-full max-w-md'}`} onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-800 shrink-0">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-2xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">{children}</div>
      </div>
    </div>
  )
}
function FInput({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label?:string }) {
  return (
    <div className="mb-3">
      {label && <label className="text-xs text-gray-400 mb-1 block">{label}</label>}
      <input {...props} className="w-full bg-[#1e293b] border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
    </div>
  )
}
function Btn({ children, onClick, variant='primary', small, disabled }: { children:React.ReactNode; onClick?:()=>void; variant?:'primary'|'secondary'|'danger'; small?:boolean; disabled?:boolean }) {
  const base = `font-semibold rounded-xl transition-colors disabled:opacity-50 cursor-pointer ${small?'px-3 py-1.5 text-xs':'px-4 py-2.5 text-sm'}`
  const v = variant==='primary'   ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
          : variant==='secondary' ? 'bg-[#1e293b] hover:bg-[#2d3f55] text-white border border-gray-700'
          :                         'bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-900/40'
  return <button className={`${base} ${v}`} onClick={onClick} disabled={disabled}>{children}</button>
}

// ══════════════════════════════════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════════════════════════════════
function LoginScreen({ onLogin }: { onLogin:(s:Session)=>void }) {
  const [tab,setTab]       = useState<'login'|'register'>('login')
  const [ident,setIdent]   = useState('')
  const [pass,setPass]     = useState('')
  const [name,setName]     = useState('')
  const [code,setCode]     = useState('')
  const [err,setErr]       = useState('')
  const [note,setNote]     = useState('')
  const [busy,setBusy]     = useState(false)
  const [tsToken,setTsToken] = useState('')
  const tsContainerRef     = useRef<HTMLDivElement>(null)
  const tsWidgetId         = useRef<string|null>(null)
  const [verify,setVerify] = useState<{ identifier: string; purpose: 'signup'|'login'; email: string }|null>(null)

  // Load Cloudflare Turnstile widget when form is visible
  useEffect(() => {
    if (verify) return // no widget needed on verify screen
    let retries = 0
    const tryRender = () => {
      const w = window as any
      if (!w.turnstile || !tsContainerRef.current) {
        if (retries++ < 20) setTimeout(tryRender, 300)
        return
      }
      if (tsWidgetId.current) {
        try { w.turnstile.remove(tsWidgetId.current) } catch {}
        tsWidgetId.current = null
      }
      tsWidgetId.current = w.turnstile.render(tsContainerRef.current, {
        sitekey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '1x00000000000000000000AA',
        callback: (t: string) => setTsToken(t),
        'expired-callback': () => setTsToken(''),
        'error-callback': () => setTsToken(''),
        theme: 'dark',
        size: 'normal',
      })
    }
    setTsToken('')
    tryRender()
    return () => {
      const w = window as any
      if (tsWidgetId.current && w.turnstile) {
        try { w.turnstile.remove(tsWidgetId.current) } catch {}
        tsWidgetId.current = null
      }
    }
  }, [tab, verify])

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setNote(''); setBusy(true)
    try {
      const body: Record<string,string> = { identifier:ident.trim(), password:pass, deviceId:getPortalDeviceId() }
      if (tab==='register') body.name = name.trim()
      if (tsToken) body.turnstileToken = tsToken
      const data = await api(`auth/${tab}`, { method:'POST', body:JSON.stringify(body) })
      if (!data.ok) { setErr(data.error||'Something went wrong'); return }
      if (data.needsVerification) {
        setVerify({
          identifier: ident.trim(),
          purpose: data.verificationPurpose === 'signup' ? 'signup' : 'login',
          email: String(data.email || ident.trim()).trim().toLowerCase(),
        })
        setCode('')
        setNote(tab==='register' ? 'Enter the verification code we emailed you to finish creating your account.' : 'Enter the sign-in code we emailed you.')
        if (tab==='register') setTab('login')
        return
      }
      onLogin(buildSession(data))
    } catch { setErr('Could not reach server.') }
    finally { setBusy(false) }
  }

  async function submitVerification(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setNote(''); setBusy(true)
    if (!verify) return
    try {
      const data = await api('auth/verify', {
        method:'POST',
        body:JSON.stringify({
          identifier: verify.identifier,
          code: code.trim(),
          purpose: verify.purpose,
          deviceId: getPortalDeviceId(),
        }),
      })
      if (!data.ok) { setErr(data.error||'Verification failed'); return }
      onLogin(buildSession(data))
    } catch {
      setErr('Could not reach server.')
    } finally {
      setBusy(false)
    }
  }

  async function resendVerification() {
    if (!verify || busy) return
    setErr(''); setNote(''); setBusy(true)
    try {
      const data = await api('auth/resend', {
        method:'POST',
        body:JSON.stringify({
          identifier: verify.identifier,
          purpose: verify.purpose,
          deviceId: getPortalDeviceId(),
        }),
      })
      if (!data.ok) { setErr(data.error||'Could not resend code'); return }
      setNote(`A fresh code was sent to ${verify.email}.`)
    } catch {
      setErr('Could not reach server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#020617] flex flex-col items-center justify-center p-6">
      {/* Cloudflare Turnstile script */}
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-6xl mb-3">🎵</div>
          <h1 className="text-2xl font-bold text-white">Ultimate Musician</h1>
          <p className="text-gray-400 text-sm mt-1">Web Portal</p>
        </div>
        <div className="bg-[#0f172a] border border-gray-800 rounded-2xl p-6">
          {verify ? (
            <form onSubmit={submitVerification} className="space-y-4">
              <div className="bg-[#1e293b] border border-gray-700 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold tracking-[0.2em] uppercase text-indigo-300">Verification</p>
                <p className="text-white text-sm mt-2">Finish {verify.purpose==='signup'?'creating your account':'signing in'} for <span className="font-semibold">{verify.email}</span>.</p>
              </div>
              <FInput
                label="6-digit Code"
                value={code}
                onChange={e=>setCode(e.target.value.replace(/\D+/g,'').slice(0,6))}
                placeholder="123456"
                inputMode="numeric"
                autoFocus
              />
              {note && <p className="text-xs px-3 py-2 rounded-lg bg-indigo-900/20 text-indigo-300">{note}</p>}
              {err && <p className="text-xs px-3 py-2 rounded-lg bg-red-900/30 text-red-400">{err}</p>}
              <button type="submit" disabled={busy||code.trim().length<6} className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold py-3 rounded-xl transition-colors">
                {busy?'…':'Verify & Continue'}
              </button>
              <div className="flex items-center justify-between gap-3 text-sm">
                <button type="button" onClick={resendVerification} disabled={busy} className="text-indigo-400 hover:text-indigo-300 disabled:opacity-50">
                  Resend code
                </button>
                <button type="button" onClick={()=>{ setVerify(null); setCode(''); setErr(''); setNote('') }} disabled={busy} className="text-gray-500 hover:text-white disabled:opacity-50">
                  Back
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex rounded-xl bg-[#1e293b] p-1 mb-6">
                {(['login','register'] as const).map(t=>(
                  <button key={t} onClick={()=>{setTab(t);setErr('');setNote('')}} className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${tab===t?'bg-indigo-600 text-white':'text-gray-400 hover:text-white'}`}>
                    {t==='login'?'Sign In':'Register'}
                  </button>
                ))}
              </div>
              <form onSubmit={submit} className="space-y-4">
                {tab==='register' && <FInput label="Full Name" value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" />}
                <FInput label="Email or Phone" value={ident} onChange={e=>setIdent(e.target.value)} placeholder="you@example.com" />
                <FInput label="Password" value={pass} onChange={e=>setPass(e.target.value)} placeholder="••••••••" type="password" />
                {/* Cloudflare Turnstile widget */}
                <div ref={tsContainerRef} className="flex justify-center my-1" />
                {note && <p className="text-xs px-3 py-2 rounded-lg bg-green-900/30 text-green-400">{note}</p>}
                {err && <p className="text-xs px-3 py-2 rounded-lg bg-red-900/30 text-red-400">{err}</p>}
                <button type="submit" disabled={busy} className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold py-3 rounded-xl transition-colors">
                  {busy?'…':tab==='login'?'Sign In':'Create Account'}
                </button>
              </form>
            </>
          )}
        </div>
        <p className="text-center text-gray-600 text-xs mt-5">Your account must first be set up in the Ultimate Musician app.</p>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// CALENDAR
// ══════════════════════════════════════════════════════════════════════════════
function CalendarView({ lib, reload, onOpenService }: { lib:LibData; reload:()=>void; onOpenService:(svc:Service)=>void }) {
  const today = new Date()
  const [year,setYear]   = useState(today.getFullYear())
  const [month,setMonth] = useState(today.getMonth())
  const [sel,setSel]     = useState<string|null>(null)
  const [showNew,setShowNew] = useState(false)
  const [newDate,setNewDate] = useState('')
  const [newTitle,setNewTitle] = useState('')
  const [newType,setNewType]   = useState('standard')
  const [saving,setSaving]     = useState(false)

  const todayStr = today.toISOString().slice(0,10)
  const svcByDate: Record<string,Service[]> = {}
  lib.services.forEach(s => { const d=(s.service_date||s.date||'').slice(0,10); if(d){svcByDate[d]=svcByDate[d]||[];svcByDate[d].push(s)} })
  const blockoutDates = new Set(lib.blockouts.map(b=>b.date))
  const firstDay = new Date(year,month,1).getDay()
  const daysInMonth = new Date(year,month+1,0).getDate()
  const cells: Array<number|null> = [...Array(firstDay).fill(null),...Array.from({length:daysInMonth},(_,i)=>i+1)]
  while (cells.length%7!==0) cells.push(null)
  function pad(n:number){ return String(n).padStart(2,'0') }
  function ds(day:number){ return `${year}-${pad(month+1)}-${pad(day)}` }

  async function createService() {
    if (!newTitle||!newDate) return
    setSaving(true)
    try {
      const svc = { id:makeId(), title:newTitle, service_date:newDate, date:newDate, type:newType, status:'draft' }
      const svcs = [...lib.services, svc]
      await api('library-push',{method:'POST',body:JSON.stringify({services:svcs})})
      setShowNew(false); setNewTitle(''); setNewDate(''); reload()
    } finally { setSaving(false) }
  }

  const upcoming = lib.services.filter(s=>(s.service_date||s.date||'')>=todayStr).sort((a,b)=>(a.service_date||a.date||'').localeCompare(b.service_date||b.date||''))
  const past     = lib.services.filter(s=>(s.service_date||s.date||'')<todayStr).sort((a,b)=>(b.service_date||b.date||'').localeCompare(a.service_date||a.date||'')).slice(0,8)
  const selSvcs  = sel ? (svcByDate[sel]||[]) : []
  const selBOs   = sel ? lib.blockouts.filter(b=>b.date===sel) : []

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Calendar</h1>
          <p className="text-gray-500 text-sm">{lib.services.length} services</p>
        </div>
        <Btn onClick={()=>{setShowNew(true);setNewDate(todayStr)}}>+ New Service</Btn>
      </div>

      <div className="bg-[#0f172a] border border-gray-800 rounded-2xl p-4 mb-4">
        <div className="flex items-center justify-between mb-4">
          <button onClick={()=>{if(month===0){setMonth(11);setYear(y=>y-1)}else setMonth(m=>m-1)}} className="text-gray-400 hover:text-white w-8 h-8 rounded-lg hover:bg-gray-800 flex items-center justify-center">‹</button>
          <h2 className="text-white font-bold">{MONTH_NAMES[month]} {year}</h2>
          <button onClick={()=>{if(month===11){setMonth(0);setYear(y=>y+1)}else setMonth(m=>m+1)}} className="text-gray-400 hover:text-white w-8 h-8 rounded-lg hover:bg-gray-800 flex items-center justify-center">›</button>
        </div>
        <div className="grid grid-cols-7 gap-1 mb-1">
          {DAY_NAMES.map(d=><div key={d} className="text-center text-xs text-gray-500 font-medium py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day,i)=>{
            if (!day) return <div key={i}/>
            const d = ds(day), isToday=d===todayStr, isSel=d===sel, isPast=d<todayStr
            const hasSvc=!!svcByDate[d]?.length, hasBO=blockoutDates.has(d)
            return (
              <button key={i} onClick={()=>setSel(sel===d?null:d)}
                className={`aspect-square rounded-xl flex flex-col items-center justify-center text-sm font-medium transition-colors
                  ${isSel?'bg-indigo-600 text-white':isToday?'border-2 border-purple-500 text-white hover:bg-gray-800/60':isPast?'text-gray-600 hover:bg-gray-800/30':'text-gray-300 hover:bg-gray-800'}`}>
                {day}
                <div className="flex gap-0.5 mt-0.5">
                  {hasSvc&&<span className={`w-1.5 h-1.5 rounded-full ${isSel?'bg-white':'bg-indigo-400'}`}/>}
                  {hasBO&&<span className={`w-1.5 h-1.5 rounded-full ${isSel?'bg-red-300':'bg-red-500'}`}/>}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {sel&&(selSvcs.length>0||selBOs.length>0)&&(
        <div className="bg-[#0f172a] border border-gray-800 rounded-2xl p-4 mb-4">
          <p className="text-white font-semibold mb-3">{fmtDate(sel)}</p>
          {selSvcs.map(svc=>(
            <div key={svc.id} className="flex items-center gap-3 bg-[#1e293b] rounded-xl p-3 mb-2">
              <span className="text-xl">{SVC_ICONS[svc.type||'standard']||'📅'}</span>
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium text-sm">{svc.title||svc.name||'Service'}</p>
                <p className="text-gray-500 text-xs capitalize">{svc.status||'draft'}</p>
              </div>
              <Btn small onClick={()=>onOpenService(svc)}>Open Plan →</Btn>
            </div>
          ))}
          {selBOs.map(bo=>(
            <div key={bo.id} className="flex items-center gap-2 bg-red-900/20 border border-red-900/30 rounded-xl p-3 mb-2">
              <span>⚠️</span>
              <p className="text-red-300 text-sm">{bo.name||bo.email} unavailable{bo.reason?`: ${bo.reason}`:''}</p>
            </div>
          ))}
        </div>
      )}

      {upcoming.length>0&&(
        <div className="mb-6">
          <h3 className="text-white font-bold mb-3">Upcoming Services</h3>
          <div className="space-y-2">
            {upcoming.map(svc=>(
              <button key={svc.id} onClick={()=>onOpenService(svc)} className="w-full text-left bg-[#0f172a] border border-gray-800 hover:border-indigo-500/50 rounded-2xl p-4 transition-colors">
                <div className="flex items-center gap-3">
                  <span className="text-xl">{SVC_ICONS[svc.type||'standard']||'📅'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold text-sm">{svc.title||svc.name||'Service'}</p>
                    <p className="text-gray-400 text-xs">{fmtDate(svc.service_date||svc.date)}</p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${svc.status==='locked'?'text-green-400 border-green-500/30 bg-green-500/10':svc.status==='ready'?'text-blue-400 border-blue-500/30 bg-blue-500/10':'text-amber-400 border-amber-500/30 bg-amber-500/10'}`}>{svc.status||'draft'}</span>
                  <span className="text-gray-600 text-lg">›</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {past.length>0&&(
        <div>
          <h3 className="text-gray-500 font-bold mb-3 text-sm uppercase tracking-wide">Past Services</h3>
          <div className="space-y-2 opacity-60">
            {past.map(svc=>(
              <button key={svc.id} onClick={()=>onOpenService(svc)} className="w-full text-left bg-[#0f172a] border border-gray-800 rounded-xl p-3 hover:opacity-80 transition-opacity">
                <div className="flex items-center gap-3">
                  <span>{SVC_ICONS[svc.type||'standard']||'📅'}</span>
                  <p className="text-gray-300 text-sm flex-1 truncate">{svc.title||svc.name||'Service'}</p>
                  <p className="text-gray-500 text-xs">{fmtDate(svc.service_date||svc.date)}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {showNew&&(
        <Modal title="New Service" onClose={()=>setShowNew(false)}>
          <FInput label="Title *" value={newTitle} onChange={e=>setNewTitle(e.target.value)} placeholder="Sunday Morning Worship" autoFocus />
          <FInput label="Date" type="date" value={newDate} onChange={e=>setNewDate(e.target.value)} />
          <div className="mb-3">
            <label className="text-xs text-gray-400 mb-1 block">Type</label>
            <select value={newType} onChange={e=>setNewType(e.target.value)} className="w-full bg-[#1e293b] border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500">
              {SVC_TYPES.map(t=><option key={t} value={t}>{SVC_ICONS[t]} {t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
            </select>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn variant="secondary" onClick={()=>setShowNew(false)}>Cancel</Btn>
            <Btn onClick={createService} disabled={saving||!newTitle||!newDate}>{saving?'Creating…':'Create Service'}</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// REHEARSAL OVERLAY
// ══════════════════════════════════════════════════════════════════════════════
function RehearsalOverlay({ songs, va, onClose }: { songs:Song[]; va:VA; onClose:()=>void }) {
  const [idx,setIdx] = useState(0)
  const song = songs[idx]
  const content = song?.chordChart||song?.lyrics||''
  const songVA  = va[song?.id||'']||{}
  const stems   = song?.latestStemsJob?.result?.stems||{}

  return (
    <div className="fixed inset-0 bg-[#020617] z-50 flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-[#0f172a] shrink-0">
        <button onClick={onClose} className="text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-800 text-sm">✕ Close</button>
        <span className="text-white font-bold truncate flex-1">{song?.title||'Rehearsal'}</span>
        {song?.key&&<KeyBadge k={song.key}/>}
        {song?.bpm&&<span className="text-xs text-gray-400">{song.bpm} BPM</span>}
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="w-44 shrink-0 border-r border-gray-800 overflow-y-auto bg-[#0b111e]">
          {songs.map((s,i)=>(
            <button key={s.id||i} onClick={()=>setIdx(i)}
              className={`w-full text-left px-3 py-3 border-b border-gray-800/50 transition-colors ${i===idx?'bg-indigo-600/20 border-l-2 border-l-indigo-500':'hover:bg-gray-800/50'}`}>
              <p className="text-xs text-gray-500 mb-0.5">{i+1}</p>
              <p className={`text-sm font-medium truncate ${i===idx?'text-white':'text-gray-300'}`}>{s.title}</p>
              {s.key&&<p className="text-xs text-gray-500">{s.key}</p>}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-5">
            <h2 className="text-2xl font-bold text-white">{song?.title}</h2>
            {song?.artist&&<p className="text-gray-400">{song.artist}</p>}
            <div className="flex gap-2 mt-2 flex-wrap">
              {song?.key&&<KeyBadge k={song.key}/>}
              {song?.bpm&&<span className="text-xs bg-[#1e293b] text-gray-300 px-2 py-0.5 rounded-full border border-gray-700">{song.bpm} BPM</span>}
              {song?.timeSig&&<span className="text-xs bg-[#1e293b] text-gray-300 px-2 py-0.5 rounded-full border border-gray-700">{song.timeSig}</span>}
            </div>
          </div>

          {Object.keys(songVA).length>0&&(
            <div className="bg-[#0f172a] border border-gray-800 rounded-xl p-4 mb-5">
              <p className="text-gray-400 text-xs uppercase tracking-wide font-bold mb-3">Vocal Assignments</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {PARTS.map(p=>{
                  const a=songVA[p]; if(!a?.name) return null
                  return (
                    <div key={p} className="bg-[#1e293b] rounded-lg p-2">
                      <p className="text-xs text-gray-500 capitalize">{p}</p>
                      <p className="text-sm text-white font-medium">{a.name}</p>
                      {a.key&&<p className="text-xs text-indigo-400">Key {a.key}</p>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="bg-[#0f172a] border border-gray-800 rounded-xl p-5 mb-5">
            <p className="text-gray-400 text-xs uppercase tracking-wide font-bold mb-3">Chord Chart / Lyrics</p>
            <ChordChart text={content}/>
          </div>

          {Object.entries(stems).length>0&&(
            <div className="bg-[#0f172a] border border-gray-800 rounded-xl p-4">
              <p className="text-gray-400 text-xs uppercase tracking-wide font-bold mb-3">Stems</p>
              <div className="space-y-2">
                {Object.entries(stems).map(([name,url])=>(
                  <div key={name} className="flex items-center gap-3 bg-[#1e293b] rounded-lg p-2">
                    <span className="text-xs w-16 capitalize" style={{color:STEM_COLORS[name]||'#9CA3AF'}}>{name}</span>
                    <audio controls src={url} className="flex-1 h-8"/>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between px-6 py-3 border-t border-gray-800 bg-[#0f172a] shrink-0">
        <Btn variant="secondary" small onClick={()=>setIdx(i=>Math.max(0,i-1))} disabled={idx===0}>⏮ Prev</Btn>
        <span className="text-gray-500 text-sm">{idx+1} / {songs.length}</span>
        <Btn variant="secondary" small onClick={()=>setIdx(i=>Math.min(songs.length-1,i+1))} disabled={idx===songs.length-1}>Next ⏭</Btn>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVICE PLAN
// ══════════════════════════════════════════════════════════════════════════════
function ServicePlanView({ svc, lib, session, reload, onBack }: { svc:Service; lib:LibData; session:Session; reload:()=>void; onBack:()=>void }) {
  const [tab,setTab]   = useState<'setlist'|'team'|'vocals'>('setlist')
  const plan = lib.plans[svc.id]||{songs:[],team:[]}
  const vaInit = lib.vocalAssignments?.[svc.id]||{}
  const [songs,setSongs]     = useState<PlanSong[]>(plan.songs||[])
  const [team,setTeam]       = useState<Member[]>(plan.team||[])
  const [va,setVA]           = useState<VA>(vaInit)
  const [songSearch,setSongSearch]   = useState('')
  const [memberSearch,setMemberSearch]= useState('')
  const [showAddSong,setShowAddSong] = useState(false)
  const [showAddMem,setShowAddMem]   = useState(false)
  const [showVocalPicker,setShowVocalPicker] = useState<{songId:string;part:typeof PARTS[number]}|null>(null)
  const [publishing,setPublishing] = useState(false)
  const [publishOk,setPublishOk]   = useState(false)
  const [showReh,setShowReh]       = useState(false)
  const [aiLoading,setAiLoading]   = useState<string|null>(null)

  const canEdit = ['owner','admin','worship_leader'].includes(session.role)
  const svcDate = svc.service_date||svc.date||''

  async function persist(s=songs,t=team,v=va) {
    const plans = {...lib.plans,[svc.id]:{songs:s,team:t}}
    const vocalAssignments = {...(lib.vocalAssignments||{}),[svc.id]:v}
    await api('library-push',{method:'POST',body:JSON.stringify({plans,vocalAssignments})})
    reload()
  }

  function addSong(s: Song) {
    const u=[...songs,{songId:s.id,title:s.title,artist:s.artist,key:s.key,order:songs.length}]
    setSongs(u); setShowAddSong(false); setSongSearch(''); persist(u)
  }
  function removeSong(id: string) { const u=songs.filter(s=>s.songId!==id); setSongs(u); persist(u) }
  function addMember(p: Person) {
    const u=[...team,{personId:p.id,id:p.id,name:p.name,roles:p.roles||[],email:p.email}]
    setTeam(u); setShowAddMem(false); setMemberSearch(''); persist(songs,u)
  }
  function removeMember(id: string) { const u=team.filter(m=>(m.personId||m.id)!==id); setTeam(u); persist(songs,u) }

  async function publish() {
    setPublishing(true)
    try { await api('publish',{method:'POST',body:JSON.stringify({serviceId:svc.id,plan:{songs,team},vocalAssignments:va})}); setPublishOk(true); setTimeout(()=>setPublishOk(false),3000) }
    finally { setPublishing(false) }
  }

  function assignVA(songId: string, part: typeof PARTS[number], person: Person|null) {
    const u={...va,[songId]:{...(va[songId]||{}),[part]:person?{personId:person.id,name:person.name}:undefined}}
    setVA(u); persist(songs,team,u); setShowVocalPicker(null)
  }

  async function aiParts(ps: PlanSong) {
    const ls=lib.songs[ps.songId]; if(!ls) return
    setAiLoading(ps.songId)
    try {
      const res=await api('ai/vocal-parts',{method:'POST',body:JSON.stringify({title:ls.title,lyrics:ls.lyrics||ls.chordChart||'',voiceCount:4})})
      if (res.parts) {
        const pm: Record<string,VAPart>={}
        if(res.parts.Soprano) pm.soprano={notes:res.parts.Soprano}
        if(res.parts.Alto)    pm.alto   ={notes:res.parts.Alto}
        if(res.parts.Tenor)   pm.tenor  ={notes:res.parts.Tenor}
        if(res.parts.Bass)    pm.bass   ={notes:res.parts.Bass}
        const u={...va,[ps.songId]:{...(va[ps.songId]||{}),...pm}}
        setVA(u); persist(songs,team,u)
      }
    } finally { setAiLoading(null) }
  }

  const libSongs = Object.values(lib.songs)
  const availSongs  = libSongs.filter(s=>!songs.find(ps=>ps.songId===s.id)&&(s.title||'').toLowerCase().includes(songSearch.toLowerCase()))
  const availPeople = lib.people.filter(p=>!team.find(m=>(m.personId||m.id)===p.id)&&(p.name||'').toLowerCase().includes(memberSearch.toLowerCase()))
  const rehSongs    = songs.map(ps=>({...lib.songs[ps.songId],...ps,id:ps.songId})).filter(Boolean) as Song[]
  const blockoutsOnDate = lib.blockouts.filter(b=>b.date===svcDate)

  return (
    <div className="flex flex-col min-h-screen">
      <div className="bg-[#0f172a] border-b border-gray-800 px-4 py-4 shrink-0">
        <div className="max-w-4xl mx-auto">
          <button onClick={onBack} className="text-indigo-400 hover:text-indigo-300 text-sm mb-3">‹ Calendar</button>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-2xl">{SVC_ICONS[svc.type||'standard']||'📅'}</span>
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold text-white">{svc.title||svc.name||'Service'}</h1>
              <p className="text-gray-400 text-sm">{fmtDate(svc.service_date||svc.date)}</p>
            </div>
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${svc.status==='locked'?'text-green-400 border-green-500/30 bg-green-500/10':svc.status==='ready'?'text-blue-400 border-blue-500/30 bg-blue-500/10':'text-amber-400 border-amber-500/30 bg-amber-500/10'}`}>{svc.status||'draft'}</span>
            {canEdit&&(
              <div className="flex gap-2 flex-wrap">
                {publishOk?<span className="text-green-400 text-sm">✅ Published!</span>:<Btn small onClick={publish} disabled={publishing}>{publishing?'…':'📤 Publish'}</Btn>}
                <Btn small variant="secondary" onClick={()=>setShowReh(true)}>🎛 Rehearsal</Btn>
              </div>
            )}
          </div>
          <div className="flex gap-1 mt-4 bg-[#1e293b] rounded-xl p-1 w-fit">
            {(['setlist','team','vocals'] as const).map(t=>(
              <button key={t} onClick={()=>setTab(t)} className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab===t?'bg-indigo-600 text-white':'text-gray-400 hover:text-white'}`}>
                {t==='setlist'?`📋 Setlist (${songs.length})`:t==='team'?`👥 Team (${team.length})`:'🎤 Vocals'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-4">

          {tab==='setlist'&&(
            <div>
              {songs.length===0?(
                <div className="text-center py-16 text-gray-500"><p className="text-4xl mb-3">🎵</p><p>No songs yet.</p>{canEdit&&<button className="text-indigo-400 mt-2 text-sm hover:underline" onClick={()=>setShowAddSong(true)}>+ Add a song</button>}</div>
              ):(
                <div className="space-y-2">
                  {songs.map((ps,i)=>{
                    const ls=lib.songs[ps.songId]
                    return (
                      <div key={ps.songId} className="flex items-center gap-3 bg-[#0f172a] border border-gray-800 rounded-xl p-4">
                        <span className="text-gray-500 text-sm w-6 text-right font-mono">{i+1}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-white font-semibold text-sm">{ps.title||ls?.title}</p>
                          {(ps.artist||ls?.artist)&&<p className="text-gray-500 text-xs">{ps.artist||ls?.artist}</p>}
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {(ps.transposedKey||ps.key||ls?.key)&&<KeyBadge k={ps.transposedKey||ps.key||ls?.key}/>}
                            {ls?.bpm&&<span className="text-xs bg-[#1e293b] text-gray-400 px-2 py-0.5 rounded-full border border-gray-700">{ls.bpm} BPM</span>}
                            {ls?.lyrics&&<span className="text-xs bg-[#1e293b] text-gray-400 px-2 py-0.5 rounded-full border border-gray-700">📝 Lyrics</span>}
                            {ls?.chordChart&&<span className="text-xs bg-[#1e293b] text-gray-400 px-2 py-0.5 rounded-full border border-gray-700">🎸 Chords</span>}
                            {ls?.latestStemsJob?.result?.stems&&<span className="text-xs px-2 py-0.5 rounded-full border border-purple-700 bg-purple-900/20 text-purple-400">🎤 Stems</span>}
                          </div>
                        </div>
                        {canEdit&&<button onClick={()=>removeSong(ps.songId)} className="text-gray-600 hover:text-red-400 text-xl">×</button>}
                      </div>
                    )
                  })}
                </div>
              )}
              {canEdit&&<div className="mt-4 flex justify-center"><Btn variant="secondary" onClick={()=>setShowAddSong(true)}>+ Add Song</Btn></div>}
            </div>
          )}

          {tab==='team'&&(
            <div>
              {team.length===0?(
                <div className="text-center py-16 text-gray-500"><p className="text-4xl mb-3">👥</p><p>No team assigned.</p>{canEdit&&<button className="text-indigo-400 mt-2 text-sm hover:underline" onClick={()=>setShowAddMem(true)}>+ Assign member</button>}</div>
              ):(
                <div className="space-y-2">
                  {team.map(m=>{
                    const unavail=blockoutsOnDate.some(b=>b.email?.toLowerCase()===(m.email||'').toLowerCase())
                    return (
                      <div key={m.personId||m.id} className={`flex items-center gap-3 bg-[#0f172a] border rounded-xl p-3 ${unavail?'border-red-900/40':'border-gray-800'}`}>
                        <Avatar name={m.name} size={38}/>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-white font-medium text-sm">{m.name}</p>
                            {unavail&&<span className="text-xs text-red-400 bg-red-900/20 border border-red-900/30 px-2 py-0.5 rounded-full">⚠️ Unavailable</span>}
                          </div>
                          {m.email&&<p className="text-gray-500 text-xs">{m.email}</p>}
                          {(m.roles||[]).length>0&&<div className="flex gap-1 mt-1 flex-wrap">{m.roles!.slice(0,3).map(r=><span key={r} className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{r}</span>)}</div>}
                        </div>
                        {canEdit&&<button onClick={()=>removeMember(m.personId||m.id||'')} className="text-gray-600 hover:text-red-400 text-xl">×</button>}
                      </div>
                    )
                  })}
                </div>
              )}
              {canEdit&&<div className="mt-4 flex justify-center"><Btn variant="secondary" onClick={()=>setShowAddMem(true)}>+ Assign Member</Btn></div>}
            </div>
          )}

          {tab==='vocals'&&(
            <div className="space-y-4">
              {songs.length===0&&<p className="text-gray-500 text-center py-10">Add songs to the setlist first.</p>}
              {songs.map(ps=>{
                const ls=lib.songs[ps.songId], songVA=va[ps.songId]||{}
                return (
                  <div key={ps.songId} className="bg-[#0f172a] border border-gray-800 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-semibold">{ps.title||ls?.title}</p>
                        {(ps.key||ls?.key)&&<KeyBadge k={ps.key||ls?.key}/>}
                      </div>
                      {canEdit&&ls?.lyrics&&<Btn small variant="secondary" onClick={()=>aiParts(ps)} disabled={aiLoading===ps.songId}>{aiLoading===ps.songId?'🤖 Thinking…':'🤖 AI Parts'}</Btn>}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {PARTS.map(part=>{
                        const a=songVA[part]
                        return (
                          <button key={part} onClick={canEdit?()=>setShowVocalPicker({songId:ps.songId,part}):undefined}
                            className={`rounded-xl p-3 text-left border transition-colors ${a?.name?'bg-indigo-900/20 border-indigo-700/50 hover:border-indigo-500':'bg-[#1e293b] border-gray-700 hover:border-gray-500'} ${!canEdit?'cursor-default':''}`}>
                            <p className="text-xs text-gray-400 capitalize mb-1">{part}</p>
                            {a?.name?<p className="text-sm text-white font-medium">{a.name}</p>:<p className="text-sm text-gray-600">—</p>}
                            {a?.key&&<p className="text-xs text-indigo-400">Key {a.key}</p>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {showAddSong&&(
        <Modal title="Add Song to Setlist" onClose={()=>{setShowAddSong(false);setSongSearch('')}}>
          <FInput placeholder="Search songs…" value={songSearch} onChange={e=>setSongSearch(e.target.value)} autoFocus/>
          <div className="space-y-2 max-h-80 overflow-y-auto mt-2">
            {availSongs.slice(0,20).map(s=>(
              <button key={s.id} onClick={()=>addSong(s)} className="w-full text-left flex items-center gap-3 bg-[#1e293b] hover:bg-[#2d3f55] rounded-xl p-3 transition-colors">
                <div className="flex-1 min-w-0"><p className="text-white text-sm font-medium truncate">{s.title}</p>{s.artist&&<p className="text-gray-500 text-xs">{s.artist}</p>}</div>
                {s.key&&<KeyBadge k={s.key}/>}
              </button>
            ))}
            {availSongs.length===0&&<p className="text-gray-500 text-center py-6 text-sm">No matching songs.</p>}
          </div>
        </Modal>
      )}

      {showAddMem&&(
        <Modal title="Assign Team Member" onClose={()=>{setShowAddMem(false);setMemberSearch('')}}>
          <FInput placeholder="Search people…" value={memberSearch} onChange={e=>setMemberSearch(e.target.value)} autoFocus/>
          <div className="space-y-2 max-h-80 overflow-y-auto mt-2">
            {availPeople.slice(0,20).map(p=>(
              <button key={p.id} onClick={()=>addMember(p)} className="w-full text-left flex items-center gap-3 bg-[#1e293b] hover:bg-[#2d3f55] rounded-xl p-3 transition-colors">
                <Avatar name={p.name} size={34}/>
                <div className="flex-1 min-w-0"><p className="text-white text-sm">{p.name}</p>{p.email&&<p className="text-gray-500 text-xs">{p.email}</p>}</div>
              </button>
            ))}
            {availPeople.length===0&&<p className="text-gray-500 text-center py-6 text-sm">No more people to add.</p>}
          </div>
        </Modal>
      )}

      {showVocalPicker&&(
        <Modal title={`Assign ${showVocalPicker.part.charAt(0).toUpperCase()+showVocalPicker.part.slice(1)}`} onClose={()=>setShowVocalPicker(null)}>
          <div className="space-y-2">
            <button onClick={()=>assignVA(showVocalPicker.songId,showVocalPicker.part,null)} className="w-full text-left flex items-center gap-2 bg-[#1e293b] hover:bg-red-900/20 rounded-xl p-3 text-red-400">✕ Remove assignment</button>
            {team.map(m=>{
              const p=lib.people.find(x=>x.id===(m.personId||m.id)); if(!p) return null
              return (
                <button key={p.id} onClick={()=>assignVA(showVocalPicker.songId,showVocalPicker.part,p)} className="w-full text-left flex items-center gap-3 bg-[#1e293b] hover:bg-indigo-900/20 rounded-xl p-3">
                  <Avatar name={p.name} size={32}/>
                  <div><p className="text-white text-sm">{p.name}</p>{(p.roles||[]).length>0&&<p className="text-gray-500 text-xs">{p.roles![0]}</p>}</div>
                </button>
              )
            })}
          </div>
        </Modal>
      )}

      {showReh&&rehSongs.length>0&&(
        <RehearsalOverlay songs={rehSongs} va={va} onClose={()=>setShowReh(false)}/>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// SONG DETAIL
// ══════════════════════════════════════════════════════════════════════════════
function SongDetailView({ song, onBack, reload }: { song:Song; onBack:()=>void; reload:()=>void }) {
  const [editing,setEditing] = useState(false)
  const [title,setTitle]     = useState(song.title||'')
  const [artist,setArtist]   = useState(song.artist||'')
  const [key,setKey]         = useState(song.key||'')
  const [bpm,setBpm]         = useState(String(song.bpm||''))
  const [timeSig,setTimeSig] = useState(song.timeSig||'4/4')
  const [content,setContent] = useState(song.chordChart||song.lyrics||'')
  const [saving,setSaving]   = useState(false)
  const [detectedMeta, setDetectedMeta] = useState<string|null>(null)
  const stems = song.latestStemsJob?.result?.stems||{}

  async function save() {
    setSaving(true)
    try {
      const isChord = content.split('\n').some(l=>classifyLine(l)==='chords')
      await api('song/patch',{method:'POST',body:JSON.stringify({...song,title,artist,key,bpm:bpm?Number(bpm):undefined,timeSig,[isChord?'chordChart':'lyrics']:content})})
      setEditing(false); reload()
    } finally { setSaving(false) }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <button onClick={onBack} className="text-indigo-400 hover:text-indigo-300 text-sm mb-4">‹ Library</button>
      {editing?(
        <div className="bg-[#0f172a] border border-gray-800 rounded-2xl p-6">
          <h2 className="text-lg font-bold text-white mb-4">Edit Song</h2>
          <FInput label="Title *" value={title} onChange={e=>setTitle(e.target.value)} placeholder="Song title"/>
          <FInput label="Artist" value={artist} onChange={e=>setArtist(e.target.value)} placeholder="Artist name"/>
          <div className="flex gap-3">
            <div className="flex-1 mb-3">
              <label className="text-xs text-gray-400 mb-1 block">Key</label>
              <select value={key} onChange={e=>setKey(e.target.value)} className="w-full bg-[#1e293b] border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500">
                <option value="">No key</option>
                {KEY_OPTIONS.map(k=><option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <FInput label="BPM" value={bpm} onChange={e=>setBpm(e.target.value)} placeholder="120" type="number"/>
            <FInput label="Time Sig" value={timeSig} onChange={e=>setTimeSig(e.target.value)} placeholder="4/4"/>
          </div>
          <div className="mb-3">
            <label className="text-xs text-gray-400 mb-1 block">Chord Chart / Lyrics</label>
            <textarea value={content} onChange={e=>{ setContent(e.target.value); setDetectedMeta(null) }} rows={20} className="w-full bg-[#1e293b] border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500 font-mono resize-y"/>
            <div className="flex items-center gap-3 mt-2">
              <button type="button" onClick={()=>{
                const meta = extractMetaFromChart(content)
                const found: string[] = []
                if (meta.key)     { setKey(meta.key);          found.push(`Key ${meta.key}`) }
                if (meta.bpm)     { setBpm(String(meta.bpm));  found.push(`${meta.bpm} BPM`) }
                if (meta.timeSig) { setTimeSig(meta.timeSig);  found.push(meta.timeSig) }
                setDetectedMeta(found.length ? found.join(' · ') : 'Nothing detected — add "Key: C", "120 BPM", or "4/4" to chart text')
              }} className="px-3 py-1.5 text-xs font-medium text-indigo-400 border border-indigo-600 rounded-lg hover:bg-indigo-600/10 transition-colors">
                🔍 Auto-detect Key / BPM / Time Sig
              </button>
              {detectedMeta && (
                <span className="text-xs text-emerald-400">✓ {detectedMeta}</span>
              )}
            </div>
          </div>
          <div className="flex gap-2"><Btn variant="secondary" onClick={()=>{ setEditing(false); setDetectedMeta(null) }}>Cancel</Btn><Btn onClick={save} disabled={saving}>{saving?'Saving…':'Save'}</Btn></div>
        </div>
      ):(
        <div>
          <div className="flex items-start gap-4 mb-6">
            <div className="w-14 h-14 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-2xl shrink-0">🎵</div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold text-white">{song.title}</h1>
              {song.artist&&<p className="text-gray-400">{song.artist}</p>}
              <div className="flex gap-2 mt-2 flex-wrap">
                {song.key&&<KeyBadge k={song.key}/>}
                {song.bpm&&<span className="text-xs bg-[#1e293b] text-gray-300 px-2 py-0.5 rounded-full border border-gray-700">{song.bpm} BPM</span>}
                {song.timeSig&&<span className="text-xs bg-[#1e293b] text-gray-300 px-2 py-0.5 rounded-full border border-gray-700">{song.timeSig}</span>}
              </div>
            </div>
            <Btn small variant="secondary" onClick={()=>setEditing(true)}>✏️ Edit</Btn>
          </div>

          {Object.keys(stems).length>0&&(
            <div className="bg-[#0f172a] border border-gray-800 rounded-xl p-4 mb-4">
              <p className="text-gray-400 text-xs uppercase tracking-wide font-bold mb-3">Stems</p>
              <div className="flex flex-wrap gap-2">
                {Object.keys(stems).map(n=>(
                  <span key={n} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border" style={{color:STEM_COLORS[n]||'#9CA3AF',borderColor:(STEM_COLORS[n]||'#9CA3AF')+'50',backgroundColor:(STEM_COLORS[n]||'#9CA3AF')+'15'}}>
                    <span className="w-2 h-2 rounded-full" style={{backgroundColor:STEM_COLORS[n]||'#9CA3AF'}}/>{n}
                  </span>
                ))}
              </div>
            </div>
          )}

          {(song.chordChart||song.lyrics)?(
            <div className="bg-[#0f172a] border border-gray-800 rounded-xl p-5">
              <p className="text-gray-400 text-xs uppercase tracking-wide font-bold mb-4">{song.chordChart?'Chord Chart':'Lyrics'}</p>
              <ChordChart text={song.chordChart||song.lyrics||''}/>
            </div>
          ):(
            <div className="bg-[#0f172a] border border-dashed border-gray-700 rounded-xl p-10 text-center">
              <p className="text-gray-500 text-sm">No chord chart or lyrics yet.</p>
              <button className="text-indigo-400 mt-2 text-sm hover:underline" onClick={()=>setEditing(true)}>+ Add content</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// LIBRARY
// ══════════════════════════════════════════════════════════════════════════════
function LibraryView({ lib, reload, onSelect }: { lib:LibData; reload:()=>void; onSelect:(s:Song)=>void }) {
  const [search,setSearch]   = useState('')
  const [showAdd,setShowAdd] = useState(false)
  const [title,setTitle]     = useState('')
  const [artist,setArtist]   = useState('')
  const [key,setKey]         = useState('')
  const [bpm,setBpm]         = useState('')
  const [content,setContent] = useState('')
  const [saving,setSaving]   = useState(false)

  const songs   = Object.values(lib.songs)
  const filtered = songs.filter(s=>!search||(s.title||'').toLowerCase().includes(search.toLowerCase())||(s.artist||'').toLowerCase().includes(search.toLowerCase()))

  async function addSong() {
    if (!title) return
    setSaving(true)
    try {
      const id=makeId()
      const isChord=content.split('\n').some(l=>classifyLine(l)==='chords')
      const song={id,title,artist,key,bpm:bpm?Number(bpm):undefined,[isChord?'chordChart':'lyrics']:content||undefined}
      await api('library-push',{method:'POST',body:JSON.stringify({songs:{...lib.songs,[id]:song}})})
      setShowAdd(false); setTitle(''); setArtist(''); setKey(''); setBpm(''); setContent(''); reload()
    } finally { setSaving(false) }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Song Library</h1>
          <p className="text-gray-500 text-sm">{songs.length} songs · {songs.filter(s=>s.latestStemsJob?.result?.stems).length} with stems</p>
        </div>
        <Btn onClick={()=>setShowAdd(true)}>+ Add Song</Btn>
      </div>

      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search songs…" className="w-full bg-[#0f172a] border border-gray-800 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-indigo-500 mb-4"/>

      {filtered.length===0?(
        <div className="text-center py-20 text-gray-500"><p className="text-4xl mb-3">🎵</p><p>{search?'No songs match.':'No songs yet.'}</p></div>
      ):(
        <div className="space-y-2">
          {filtered.map(s=>(
            <button key={s.id} onClick={()=>onSelect(s)} className="w-full text-left bg-[#0f172a] border border-gray-800 hover:border-indigo-500/50 rounded-2xl p-4 transition-colors flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center shrink-0">🎵</div>
              <div className="flex-1 min-w-0">
                <p className="text-white font-semibold text-sm truncate">{s.title}</p>
                {s.artist&&<p className="text-gray-500 text-xs truncate">{s.artist}</p>}
                <div className="flex gap-1 mt-1 flex-wrap">
                  {s.key&&<KeyBadge k={s.key}/>}
                  {s.bpm&&<span className="text-xs bg-[#1e293b] text-gray-400 px-2 py-0.5 rounded-full border border-gray-700">{s.bpm} BPM</span>}
                  {s.lyrics&&<span className="text-xs bg-[#1e293b] text-gray-400 px-2 py-0.5 rounded-full border border-gray-700">📝</span>}
                  {s.chordChart&&<span className="text-xs bg-[#1e293b] text-gray-400 px-2 py-0.5 rounded-full border border-gray-700">🎸</span>}
                  {s.latestStemsJob?.result?.stems&&<span className="text-xs px-2 py-0.5 rounded-full border border-purple-700 bg-purple-900/20 text-purple-400">🎤 Stems</span>}
                </div>
              </div>
              <span className="text-gray-600 text-xl">›</span>
            </button>
          ))}
        </div>
      )}

      {showAdd&&(
        <Modal title="Add Song" wide onClose={()=>setShowAdd(false)}>
          <FInput label="Title *" value={title} onChange={e=>setTitle(e.target.value)} placeholder="Song title" autoFocus/>
          <FInput label="Artist" value={artist} onChange={e=>setArtist(e.target.value)} placeholder="Artist name"/>
          <div className="flex gap-3">
            <div className="flex-1 mb-3">
              <label className="text-xs text-gray-400 mb-1 block">Key</label>
              <select value={key} onChange={e=>setKey(e.target.value)} className="w-full bg-[#1e293b] border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500">
                <option value="">No key</option>{KEY_OPTIONS.map(k=><option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <FInput label="BPM" value={bpm} onChange={e=>setBpm(e.target.value)} placeholder="120" type="number"/>
          </div>
          <div className="mb-3">
            <label className="text-xs text-gray-400 mb-1 block">Chord Chart / Lyrics</label>
            <textarea value={content} onChange={e=>setContent(e.target.value)} rows={12} placeholder="Paste chord chart or lyrics here…" className="w-full bg-[#1e293b] border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-indigo-500 font-mono resize-y"/>
          </div>
          <div className="flex gap-2"><Btn variant="secondary" onClick={()=>setShowAdd(false)}>Cancel</Btn><Btn onClick={addSong} disabled={saving||!title}>{saving?'Adding…':'Add Song'}</Btn></div>
        </Modal>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PEOPLE & ROLES
// ══════════════════════════════════════════════════════════════════════════════
function PeopleView({ lib, session, orgRoles, reload }: { lib:LibData; session:Session; orgRoles:Record<string,string>; reload:()=>void }) {
  const [search,setSearch]     = useState('')
  const [showForm,setShowForm] = useState(false)
  const [editP,setEditP]       = useState<Person|null>(null)
  const [name,setName]         = useState('')
  const [email,setEmail]       = useState('')
  const [phone,setPhone]       = useState('')
  const [selRoles,setSelRoles] = useState<string[]>([])
  const [saving,setSaving]     = useState(false)
  const [roleMenu,setRoleMenu] = useState<string|null>(null)

  const canManage = ['owner','admin','worship_leader'].includes(session.role)
  const filtered  = lib.people.filter(p=>!search||(p.name||'').toLowerCase().includes(search.toLowerCase())||(p.email||'').toLowerCase().includes(search.toLowerCase()))

  function openAdd()       { setEditP(null);setName('');setEmail('');setPhone('');setSelRoles([]);setShowForm(true) }
  function openEdit(p:Person){ setEditP(p);setName(p.name||'');setEmail(p.email||'');setPhone(p.phone||'');setSelRoles(p.roles||[]);setShowForm(true) }

  async function savePerson() {
    if(!name) return; setSaving(true)
    try {
      const person: Person = editP?{...editP,name,email,phone,roles:selRoles}:{id:makeId(),name,email,phone,roles:selRoles}
      const updated = editP?lib.people.map(p=>p.id===editP.id?person:p):[...lib.people,person]
      await api('library-push',{method:'POST',body:JSON.stringify({people:updated})})
      setShowForm(false); reload()
    } finally { setSaving(false) }
  }

  async function setOrgRole(em:string, role:string|null) {
    await api('role/set',{method:'POST',body:JSON.stringify({email:em,role})})
    setRoleMenu(null); reload()
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div><h1 className="text-2xl font-bold text-white">People & Roles</h1><p className="text-gray-500 text-sm">{lib.people.length} members</p></div>
        {canManage&&<Btn onClick={openAdd}>+ Add Member</Btn>}
      </div>

      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search people…" className="w-full bg-[#0f172a] border border-gray-800 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-indigo-500 mb-4"/>

      {filtered.length===0?(
        <div className="text-center py-20 text-gray-500"><p className="text-4xl mb-3">👥</p><p>{search?'No people match.':'No team members yet.'}</p></div>
      ):(
        <div className="space-y-2">
          {filtered.map(p=>{
            const orgRole=orgRoles[(p.email||'').toLowerCase()]
            return (
              <div key={p.id} className="bg-[#0f172a] border border-gray-800 rounded-2xl p-4 flex items-center gap-3 relative">
                <Avatar name={p.name} size={42}/>
                <div className="flex-1 min-w-0 cursor-pointer" onClick={()=>canManage&&openEdit(p)}>
                  <p className="text-white font-semibold text-sm">{p.name}</p>
                  <p className="text-gray-500 text-xs truncate">{p.email||p.phone||'—'}</p>
                  {(p.roles||[]).length>0&&<div className="flex gap-1 mt-1 flex-wrap">{p.roles!.slice(0,4).map(r=><span key={r} className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{r}</span>)}</div>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {orgRole&&<RoleBadge role={orgRole}/>}
                  {canManage&&session.role!=='worship_leader'&&p.email&&orgRole!=='owner'&&(
                    <div className="relative">
                      <button onClick={()=>setRoleMenu(roleMenu===p.id?null:p.id)} className="text-gray-500 hover:text-white w-8 h-8 rounded-lg hover:bg-gray-800 flex items-center justify-center">⋮</button>
                      {roleMenu===p.id&&(
                        <div className="absolute right-0 top-9 bg-[#1e293b] border border-gray-700 rounded-xl shadow-xl z-10 py-1 min-w-44">
                          <p className="text-xs text-gray-500 px-3 py-1">Set org role</p>
                          {(['admin','worship_leader',null] as const).map(r=>(
                            <button key={r||'none'} onClick={()=>setOrgRole(p.email!,r)} className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-700 ${orgRole===r?'text-indigo-400':'text-gray-300'}`}>
                              {r?ORG_ROLE_LABELS[r]:'Remove role'}
                            </button>
                          ))}
                          <button onClick={()=>setRoleMenu(null)} className="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-700">Cancel</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showForm&&(
        <Modal title={editP?`Edit ${editP.name}`:'Add Team Member'} onClose={()=>setShowForm(false)}>
          <FInput label="Name *" value={name} onChange={e=>setName(e.target.value)} placeholder="Full name" autoFocus/>
          <FInput label="Email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="email@example.com" type="email"/>
          <FInput label="Phone" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+1 234 567 8900"/>
          <div className="mb-4">
            <label className="text-xs text-gray-400 mb-2 block">Roles</label>
            <div className="flex flex-wrap gap-2">
              {ROLE_OPTIONS_LIST.map(r=>(
                <button key={r} onClick={()=>setSelRoles(prev=>prev.includes(r)?prev.filter(x=>x!==r):[...prev,r])}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${selRoles.includes(r)?'bg-indigo-600 border-indigo-500 text-white':'bg-[#1e293b] border-gray-700 text-gray-400 hover:text-white'}`}>{r}</button>
              ))}
            </div>
          </div>
          <div className="flex gap-2"><Btn variant="secondary" onClick={()=>setShowForm(false)}>Cancel</Btn><Btn onClick={savePerson} disabled={saving||!name}>{saving?'Saving…':editP?'Save':'Add Member'}</Btn></div>
        </Modal>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PORTAL SHELL
// ══════════════════════════════════════════════════════════════════════════════
type View = 'calendar'|'service'|'library'|'song'|'people'

function Portal({ session, onLogout }: { session:Session; onLogout:()=>void }) {
  const [view,setView]         = useState<View>('calendar')
  const [lib,setLib]           = useState<LibData|null>(null)
  const [orgRoles,setOrgRoles] = useState<Record<string,string>>({})
  const [loading,setLoading]   = useState(true)
  const [activeSvc,setActiveSvc]   = useState<Service|null>(null)
  const [activeSong,setActiveSong] = useState<Song|null>(null)

  const load = useCallback(async()=>{
    setLoading(true)
    try {
      const [data,roles] = await Promise.all([api('library-pull'),api('roles')])
      setLib({ songs:data.songs||{}, people:Array.isArray(data.people)?data.people:[], services:Array.isArray(data.services)?data.services:[], plans:data.plans||{}, vocalAssignments:data.vocalAssignments||{}, blockouts:Array.isArray(data.blockouts)?data.blockouts:[] })
      setOrgRoles(roles||{})
    } catch(e){ console.error(e) }
    setLoading(false)
  },[])

  useEffect(()=>{ load() },[load])

  function openService(svc:Service){ setActiveSvc(svc); setView('service') }
  function openSong(s:Song)        { setActiveSong(s);  setView('song') }

  const nav = [
    {id:'calendar' as View, label:'Calendar', icon:'📅'},
    {id:'library'  as View, label:'Library',  icon:'🎵'},
    {id:'people'   as View, label:'People',   icon:'👥'},
  ]

  return (
    <div className="min-h-screen bg-[#020617] flex flex-col">
      <div className="sticky top-0 z-40 bg-[#020617]/95 backdrop-blur border-b border-gray-800">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="text-xl">🎵</span>
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold text-sm truncate">{session.orgName}</p>
            <p className="text-gray-500 text-xs">{session.name}</p>
          </div>
          <RoleBadge role={session.role}/>
          <button onClick={onLogout} className="text-gray-500 hover:text-white text-sm px-3 py-1 rounded-lg hover:bg-gray-800 ml-2">Sign out</button>
        </div>
        <div className="px-4 pb-3">
          <div className="flex rounded-xl bg-[#1e293b] p-1 gap-1 w-fit">
            {nav.map(n=>(
              <button key={n.id} onClick={()=>{ setView(n.id); if(n.id!=='service') setActiveSvc(null); if(n.id!=='song') setActiveSong(null) }}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 ${(view===n.id||(n.id==='calendar'&&view==='service')||(n.id==='library'&&view==='song'))?'bg-indigo-600 text-white':'text-gray-400 hover:text-white'}`}>
                <span>{n.icon}</span>{n.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading||!lib ? (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          <div className="text-center"><div className="text-4xl mb-3 animate-pulse">🎵</div><p>Loading…</p></div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {view==='calendar'&&<CalendarView lib={lib} reload={load} onOpenService={openService}/>}
          {view==='service'&&activeSvc&&<ServicePlanView svc={activeSvc} lib={lib} session={session} reload={load} onBack={()=>setView('calendar')}/>}
          {view==='library'&&!activeSong&&<LibraryView lib={lib} reload={load} onSelect={openSong}/>}
          {view==='song'&&activeSong&&<SongDetailView song={activeSong} onBack={()=>setView('library')} reload={async()=>{ await load() }}/>}
          {view==='people'&&<PeopleView lib={lib} session={session} orgRoles={orgRoles} reload={load}/>}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOT
// ══════════════════════════════════════════════════════════════════════════════
export default function PortalPage() {
  const [session,setSession] = useState<Session|null>(null)
  const [ready,setReady]     = useState(false)
  useEffect(()=>{
    let cancelled = false
    async function restoreSession() {
      try {
        const data = await api('auth/session')
        if (!cancelled) setSession(data.ok ? buildSession(data) : null)
      } catch {
        if (!cancelled) setSession(null)
      } finally {
        if (!cancelled) setReady(true)
      }
    }
    function handleAuthExpired() {
      setSession(null)
    }
    window.addEventListener('portal-auth-expired', handleAuthExpired)
    restoreSession()
    return () => {
      cancelled = true
      window.removeEventListener('portal-auth-expired', handleAuthExpired)
    }
  },[])
  if (!ready) return null
  return session
    ? <Portal session={session} onLogout={async()=>{ try { await api('auth/logout', { method:'POST' }) } finally { setSession(null) } }}/>
    : <LoginScreen onLogin={s=>{ setSession(s) }}/>
}
