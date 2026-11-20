import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../util.js';
import {
  Confirm, ErrorBox, Loading, Modal, useCanWrite, useToast,
} from '../components/ui.jsx';

export default function Employees() {
  const employees = useApi('/people/employees');
  const departments = useApi('/people/departments');
  const canWrite = useCanWrite();
  const toast = useToast();
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const [newDept, setNewDept] = useState('');
  const [filter, setFilter] = useState('');

  const save = async (e) => {
    e.preventDefault();
    try {
      const body = { name: edit.name, email: edit.email, departmentId: edit.department_id || null, active: edit.active };
      if (edit.id) await api(`/people/employees/${edit.id}`, { method: 'PATCH', body });
      else await api('/people/employees', { method: 'POST', body });
      setEdit(null);
      employees.reload();
      toast('Saved');
    } catch (err) { toast(err, 'error'); }
  };

  const addDept = async (e) => {
    e.preventDefault();
    try {
      await api('/people/departments', { method: 'POST', body: { name: newDept } });
      setNewDept('');
      departments.reload();
    } catch (err) { toast(err, 'error'); }
  };

  const list = (employees.data || []).filter((e) => !filter || `${e.name} ${e.email || ''} ${e.department_name || ''}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <div className="page-head">
        <div><h1>Employees</h1><div className="sub">People that machines are assigned to</div></div>
        {canWrite && <button className="primary" onClick={() => setEdit({ name: '', email: '', department_id: '', active: true })}>+ Add employee</button>}
      </div>
      <div className="grid cols-3">
        <div className="card flush span-2">
          <div style={{ padding: 14 }}><input placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
          <ErrorBox error={employees.error} />
          {employees.loading && !employees.data ? <Loading /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Email</th><th>Department</th><th className="num">Machines</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {list.length === 0 && <tr><td colSpan={6} className="empty">No employees yet</td></tr>}
                  {list.map((e) => (
                    <tr key={e.id}>
                      <td><b>{e.name}</b></td><td>{e.email || '—'}</td><td>{e.department_name || '—'}</td>
                      <td className="num">{e.device_count}</td>
                      <td>{e.active ? <span className="badge good">Active</span> : <span className="badge">Inactive</span>}</td>
                      <td className="num">
                        {canWrite && (
                          <>
                            <button className="sm ghost" onClick={() => setEdit({ ...e, department_id: e.department_id || '' })}>Edit</button>
                            <button className="sm ghost danger" onClick={() => setDel(e)}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h2>Departments</h2>
          {canWrite && (
            <form className="row" onSubmit={addDept} style={{ flexWrap: 'nowrap', marginBottom: 12 }}>
              <input placeholder="New department" value={newDept} onChange={(e) => setNewDept(e.target.value)} style={{ flex: 1 }} />
              <button disabled={!newDept}>Add</button>
            </form>
          )}
          {departments.data?.length === 0 && <div className="muted small">No departments</div>}
          {departments.data?.map((d) => (
            <div key={d.id} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{d.name} <span className="muted small">({d.employee_count})</span></span>
              {canWrite && <button className="sm ghost danger" onClick={async () => { await api(`/people/departments/${d.id}`, { method: 'DELETE' }); departments.reload(); employees.reload(); }}>×</button>}
            </div>
          ))}
        </div>
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit employee' : 'Add employee'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={save}>
            <label className="field">Name<input required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field">Email<input type="email" value={edit.email || ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></label>
            <label className="field">Department
              <select value={edit.department_id} onChange={(e) => setEdit({ ...edit, department_id: e.target.value })}>
                <option value="">—</option>
                {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Active</label>
            <div className="actions" style={{ marginTop: 0 }}>
              <button type="button" onClick={() => setEdit(null)}>Cancel</button>
              <button className="primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
      {del && (
        <Confirm title={`Delete ${del.name}?`} danger confirmLabel="Delete"
          message="Their machines become unassigned. Recorded activity is kept but no longer linked to a name."
          onClose={() => setDel(null)}
          onConfirm={async () => { await api(`/people/employees/${del.id}`, { method: 'DELETE' }); employees.reload(); }} />
      )}
    </>
  );
}
