import { useState } from 'react';
import { useOrg } from '../App.jsx';
import { downloadCsv } from '../api.js';
import { fmtDuration, fmtTime, today, useApi } from '../util.js';
import { DateRange, SubjectFilter, qs } from '../components/Filters.jsx';
import {
  CategoryBadge, ErrorBox, Loading, ProductivityMeter, useToast,
} from '../components/ui.jsx';

export default function Activity() {
  const org = useOrg();
  const toast = useToast();
  const [range, setRange] = useState({ from: today(org.timezone), to: today(org.timezone) });
  const [subject, setSubject] = useState({ employeeId: '', deviceId: '', departmentId: '' });
  const [tab, setTab] = useState('attendance');
  const params = qs({ ...range, ...subject });
  const summary = useApi(`/analytics/summary${params}`);
  const attendance = useApi(tab === 'attendance' ? `/analytics/attendance${params}` : null);
  const usage = useApi(tab === 'usage' ? `/analytics/usage${params}` : null);

  const csv = async (kind) => {
    try { await downloadCsv(`/analytics/${kind}${params}${params ? '&' : '?'}format=csv`, `${kind}_${range.from}_${range.to}.csv`); } catch (e) { toast(e, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Activity &amp; reports</h1><div className="sub">Attendance, app &amp; website usage, productivity</div></div>
        <div className="row">
          <SubjectFilter value={subject} onChange={setSubject} />
          <DateRange value={range} onChange={setRange} tz={org.timezone} />
        </div>
      </div>
      {summary.data && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 28, marginBottom: 12 }}>
            <div><div className="muted small">Active</div><b style={{ fontSize: 20 }}>{fmtDuration(summary.data.totals.active)}</b></div>
            <div><div className="muted small">Idle</div><b style={{ fontSize: 20 }}>{fmtDuration(summary.data.totals.idle)}</b></div>
            <div><div className="muted small">Productivity</div><b style={{ fontSize: 20 }}>{summary.data.totals.productivity}%</b></div>
          </div>
          <ProductivityMeter {...summary.data.totals} />
        </div>
      )}
      <div className="tabs">
        <button className={tab === 'attendance' ? 'active' : ''} onClick={() => setTab('attendance')}>Attendance</button>
        <button className={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}>Apps &amp; websites</button>
        <button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>Productivity by person</button>
      </div>

      {tab === 'attendance' && (
        <div className="card flush">
          <div className="row between" style={{ padding: 14 }}>
            <span className="muted small">First and last activity per person per day ({org.timezone})</span>
            <button className="sm" onClick={() => csv('attendance')}>Export CSV</button>
          </div>
          <ErrorBox error={attendance.error} />
          {attendance.loading ? <Loading /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Name</th><th>First activity</th><th>Last activity</th><th className="num">Span</th><th className="num">Active</th><th className="num">Idle</th></tr></thead>
                <tbody>
                  {!attendance.data?.length && <tr><td colSpan={7} className="empty">No activity in this period</td></tr>}
                  {attendance.data?.map((r) => (
                    <tr key={`${r.day}-${r.employeeId}-${r.deviceId}`}>
                      <td>{r.day}</td><td>{r.name}</td>
                      <td>{fmtTime(r.firstAt, org.timezone)}</td><td>{fmtTime(r.lastAt, org.timezone)}</td>
                      <td className="num">{fmtDuration((new Date(r.lastAt) - new Date(r.firstAt)) / 1000)}</td>
                      <td className="num">{fmtDuration(r.active)}</td><td className="num">{fmtDuration(r.idle)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'usage' && (
        <div className="card flush">
          <div className="row between" style={{ padding: 14 }}>
            <span className="muted small">Categories come from your productivity rules</span>
            <button className="sm" onClick={() => csv('usage')}>Export CSV</button>
          </div>
          {usage.loading ? <Loading /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Application</th><th>Website</th><th>Category</th><th className="num">Machines</th><th className="num">Time</th></tr></thead>
                <tbody>
                  {!usage.data?.length && <tr><td colSpan={5} className="empty">No usage in this period</td></tr>}
                  {usage.data?.map((r) => (
                    <tr key={`${r.app}|${r.domain}`}>
                      <td>{r.app}</td><td>{r.domain || <span className="muted">—</span>}</td>
                      <td><CategoryBadge category={r.category} /></td>
                      <td className="num">{r.devices}</td><td className="num">{fmtDuration(r.seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'people' && (
        <div className="card flush">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th className="num">Days</th><th className="num">Active</th><th className="num">Avg / day</th><th className="num">Productive</th><th className="num">Unproductive</th><th className="num">Idle</th><th className="num">Productivity</th></tr></thead>
              <tbody>
                {!summary.data?.people?.length && <tr><td colSpan={8} className="empty">No data</td></tr>}
                {summary.data?.people?.map((p) => (
                  <tr key={p.key}>
                    <td>{p.name}</td><td className="num">{p.days}</td>
                    <td className="num">{fmtDuration(p.active)}</td><td className="num">{fmtDuration(p.active / Math.max(1, p.days))}</td>
                    <td className="num">{fmtDuration(p.productive)}</td><td className="num">{fmtDuration(p.unproductive)}</td>
                    <td className="num">{fmtDuration(p.idle)}</td><td className="num"><b>{p.productivity}%</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
