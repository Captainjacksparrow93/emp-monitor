import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useOrg } from '../App.jsx';
import { fileUrl } from '../api.js';
import { fmtDuration, fmtTime, today, useApi, useInterval, timeAgo } from '../util.js';
import { DateRange, SubjectFilter, qs } from '../components/Filters.jsx';
import {
  BarList, ErrorBox, Loading, ProductivityMeter, Stat, StatusDot,
} from '../components/ui.jsx';

export default function Overview() {
  const org = useOrg();
  const [range, setRange] = useState({ from: today(org.timezone), to: today(org.timezone) });
  const [subject, setSubject] = useState({ employeeId: '', deviceId: '', departmentId: '' });
  const summary = useApi(`/analytics/summary${qs({ ...range, ...subject })}`);
  const devices = useApi('/devices');
  const shots = useApi(`/screenshots${qs({ limit: 8, ...subject })}`);
  useInterval(() => devices.reload(), 30000); // memory-only endpoint: free to poll

  const s = summary.data;
  const online = devices.data?.filter((d) => d.online) || [];
  const hourly = (s?.hourly || []).map((h) => ({
    hour: `${String(h.hour).padStart(2, '0')}:00`, Active: +(h.active / 3600).toFixed(2), Idle: +(h.idle / 3600).toFixed(2),
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="sub">{org.name} · times shown in {org.timezone}</div>
        </div>
        <div className="row">
          <SubjectFilter value={subject} onChange={setSubject} />
          <DateRange value={range} onChange={setRange} tz={org.timezone} />
        </div>
      </div>
      <ErrorBox error={summary.error} />

      <div className="grid cols-4">
        <Stat label="Machines online" value={`${online.length} / ${devices.data?.length ?? '–'}`}
          hint={`${online.filter((d) => d.idleSec > 180).length} idle right now`} />
        <Stat label="Active time" value={s ? fmtDuration(s.totals.active) : '–'}
          hint={s ? `${s.totals.employees || s.totals.devices} tracked` : ''} />
        <Stat label="Productivity" value={s ? `${s.totals.productivity}%` : '–'} hint={s ? `${fmtDuration(s.totals.productive)} productive` : ''} />
        <Stat label="Idle time" value={s ? fmtDuration(s.totals.idle) : '–'}
          hint={s && s.totals.active + s.totals.idle ? `${Math.round((s.totals.idle / (s.totals.active + s.totals.idle)) * 100)}% of tracked time` : ''} />
      </div>

      <div className="grid cols-3 mt">
        <div className="card span-2">
          <h2>Activity by hour</h2>
          {summary.loading && !s ? <Loading /> : (
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={hourly} margin={{ left: -18, right: 4 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="hour" tick={{ fontSize: 11, fill: 'var(--muted)' }} interval={2} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} unit="h" />
                  <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8 }}
                    formatter={(v) => fmtDuration(v * 3600)} cursor={{ fill: 'var(--panel-2)' }} />
                  <Bar dataKey="Active" stackId="a" fill="var(--accent)" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="Idle" stackId="a" fill="var(--idle)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt"><ProductivityMeter {...(s?.totals || {})} /></div>
        </div>
        <div className="card">
          <div className="row between"><h2>Live</h2><Link to="/machines" className="small">All machines →</Link></div>
          {!devices.data ? <Loading /> : online.length === 0 ? <div className="empty">No machines online</div> : (
            <div className="stack" style={{ gap: 10 }}>
              {online.slice(0, 8).map((d) => (
                <Link key={d.id} to={`/machines/${d.id}`} style={{ color: 'inherit' }}>
                  <div className="row between">
                    <b>{d.employeeName || d.name}</b>
                    <span className="small"><StatusDot device={d} /></span>
                  </div>
                  <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.idleSec > 180 ? `Idle for ${fmtDuration(d.idleSec)}` : d.current ? `${d.current.app}${d.current.domain ? ` · ${d.current.domain}` : ''}` : '—'}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid cols-2 mt">
        <div className="card"><h2>Top applications</h2><BarList items={s?.topApps?.slice(0, 8)} /></div>
        <div className="card"><h2>Top websites</h2><BarList items={s?.topDomains?.slice(0, 8)} /></div>
      </div>

      <div className="card flush mt">
        <div style={{ padding: '16px 18px 4px' }}><h2>Team</h2></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>First activity</th><th>Last activity</th>
                <th className="num">Active</th><th className="num">Idle</th><th className="num">Productive</th><th style={{ width: 160 }}>Productivity</th>
              </tr>
            </thead>
            <tbody>
              {s?.people?.length ? s.people.map((p) => (
                <tr key={p.key}>
                  <td>{p.name}</td>
                  <td>{range.from === range.to ? fmtTime(p.firstAt, org.timezone) : `${p.days} days`}</td>
                  <td>{fmtTime(p.lastAt, org.timezone)}</td>
                  <td className="num">{fmtDuration(p.active)}</td>
                  <td className="num">{fmtDuration(p.idle)}</td>
                  <td className="num">{fmtDuration(p.productive)}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <div className="meter" style={{ flex: 1 }}><span className="good" style={{ width: `${p.productivity}%` }} /></div>
                      <span className="small">{p.productivity}%</span>
                    </div>
                  </td>
                </tr>
              )) : <tr><td colSpan={7} className="empty">{summary.loading ? 'Loading…' : 'No activity recorded for this period yet'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card mt">
        <div className="row between"><h2>Latest screenshots</h2><Link to="/screenshots" className="small">Gallery →</Link></div>
        {shots.data?.length ? (
          <div className="shots">
            {shots.data.map((x) => (
              <Link key={x.id} to="/screenshots" className="shot" style={{ color: 'inherit' }}>
                <img src={fileUrl(x.url)} alt="" loading="lazy" />
                <div className="meta"><b>{x.employeeName || x.deviceName}</b><span className="muted">{x.app || '—'} · {timeAgo(x.takenAt)}</span></div>
              </Link>
            ))}
          </div>
        ) : <div className="empty">No screenshots yet</div>}
      </div>
    </>
  );
}
