import { describe, it, expect } from 'vitest'
import { mapDeviceResponse, parseTimestamp, getByPath } from './attendance.mapping.js'
const mapping = { recordsPath: 'data.records', employeePath: 'uid', employeeMatchBy: 'matricule',
  timestampPath: 'time', timestampFormat: 'iso8601', directionPath: 'state', directionInValue: '0', directionOutValue: '1' } as const
describe('mapDeviceResponse', () => {
  it('extrait les pointages via les chemins configurés', () => {
    const body = { data: { records: [ { uid: 'M001', time: '2026-07-08T08:05:00Z', state: '0' } ] } }
    const out = mapDeviceResponse(body, mapping)
    expect(out).toHaveLength(1)
    expect(out[0]!.rawEmployeeRef).toBe('M001')
    expect(out[0]!.direction).toBe('in')
    expect(out[0]!.punchedAt.toISOString()).toBe('2026-07-08T08:05:00.000Z')
    expect(out[0]!.dedupKey).toBe('M001|2026-07-08T08:05:00.000Z')
  })
  it('sens inconnu si directionPath absent', () => {
    const out = mapDeviceResponse({ data: { records: [ { uid: 'M2', time: '2026-07-08T09:00:00Z' } ] } },
      { ...mapping, directionPath: undefined })
    expect(out[0]!.direction).toBe('unknown')
  })
  it('ignore les enregistrements sans horodatage valide', () => {
    const out = mapDeviceResponse({ data: { records: [ { uid: 'M3', time: 'nope' } ] } }, mapping)
    expect(out).toHaveLength(0)
  })
})
describe('parseTimestamp', () => {
  it('epoch_s', () => { expect(parseTimestamp(1751961900, 'epoch_s')!.toISOString()).toBe('2025-07-08T08:05:00.000Z') })
  it('invalide → null', () => { expect(parseTimestamp('x', 'iso8601')).toBeNull() })
})
describe('getByPath — garde anti-prototype-pollution', () => {
  it('ignore les segments __proto__/constructor/prototype et renvoie undefined', () => {
    expect(getByPath({ a: { b: 1 } }, '__proto__.polluted')).toBeUndefined()
    expect(getByPath({ a: 1 }, 'constructor.name')).toBeUndefined()
    expect(getByPath(JSON.parse('{"a":{"b":2}}'), 'a.__proto__.b')).toBeUndefined()
  })
  it('ne remonte jamais de propriétés héritées (walk plain-object uniquement)', () => {
    expect(getByPath({}, 'toString')).toBeUndefined()
  })
})
