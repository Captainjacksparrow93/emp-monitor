import { useApi, shiftDate, today } from '../util.js';
import { api } from '../api.js';
import { useEffect, useState } from 'react';

let peopleCache = null;
/** Shared list of employees/devices/departments for filter dropdowns. */
export function useLookups() {
  const [data, setData] = useState(peopleCache || { employees: [], devices: [], departments: [] });
  useEffect(() => {
    let alive = true;
    Promise.all([api('/people/employees'), api('/devices'), api('/people/departments')])
      .then(([employees, devices, departments]) => {
        peopleCache = { employees, devices, departments };
        if (alive) setData(peopleCache);
      }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return data;
}

export function DateRange({ value, onChange, tz }) {
  const t = today(tz);
  const presets = [
    ['Today', t, t],
    ['Yesterday', shiftDate(t, -1), shiftDate(t, -1)],
    ['Last 7 days', shiftDate(t, -6), t],
    ['Last 30 days', shiftDate(t, -29), t],
  ];
  return (
    <div className="row">
      <select value={presets.find((p) => p[1] === value.from && p[2] === value.to)?.[0] || 'custom'}
        onChange={(e) => {
          const p = presets.find((x) => x[0] === e.target.value);
          if (p) onChange({ from: p[1], to: p[2] });
        }}>
        {presets.map((p) => <option key={p[0]}>{p[0]}</option>)}
        <option value="custom">Custom</option>
      </select>
      <input type="date" value={value.from} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} />
      <span className="muted">→</span>
      <input type="date" value={value.to} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value })} />
    </div>
  );
}

export function SubjectFilter({ value, onChange }) {
  const { employees, devices, departments } = useLookups();
  const v = value.employeeId ? `e:${value.employeeId}` : value.deviceId ? `d:${value.deviceId}` : value.departmentId ? `g:${value.departmentId}` : '';
  return (
    <select value={v} onChange={(e) => {
      const [k, id] = e.target.value.split(':');
      onChange({ employeeId: k === 'e' ? id : '', deviceId: k === 'd' ? id : '', departmentId: k === 'g' ? id : '' });
    }}>
      <option value="">Everyone</option>
      {departments.length > 0 && (
        <optgroup label="Departments">
          {departments.map((d) => <option key={d.id} value={`g:${d.id}`}>{d.name}</option>)}
        </optgroup>
      )}
      <optgroup label="Employees">
        {employees.map((e) => <option key={e.id} value={`e:${e.id}`}>{e.name}</option>)}
      </optgroup>
      <optgroup label="Machines">
        {devices.map((d) => <option key={d.id} value={`d:${d.id}`}>{d.name}</option>)}
      </optgroup>
    </select>
  );
}

export function qs(obj) {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== '' && v !== undefined && v !== null) p.set(k, v); });
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useSettings() {
  return useApi('/settings');
}
