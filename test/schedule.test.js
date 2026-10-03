import test from 'node:test'
import assert from 'node:assert/strict'
import { UpdateSchedule } from '../schedule.js'
const options = { scheduledChecks: true, checkIntervalMinutes: 30, autoApply: true, updateTimeMinutes: 180, updateWindowMinutes: 60 }
const at = (hour, minute = 0) => new Date(2026, 9, 3, hour, minute).getTime()
test('checks catch up after sleep and live interval changes, disabled checks stay disabled', () => {
  const schedule = new UpdateSchedule(at(1))
  assert.equal(schedule.view(at(1, 29), options).checkDue, false)
  assert.equal(schedule.view(at(2), options).checkDue, true)
  schedule.checked(at(2))
  assert.equal(schedule.view(at(2, 10), { ...options, checkIntervalMinutes: 5 }).checkDue, true)
  assert.equal(schedule.view(at(2, 10), { ...options, scheduledChecks: false }).nextCheckAt, null)
  schedule.checked(at(2, 10))
  assert.equal(schedule.view(at(2, 11), options).checkDue, false)
})
test('daily installation checks once per window and never install outside it', () => {
  const schedule = new UpdateSchedule(at(2))
  assert.equal(schedule.view(at(2, 59), options).updateDue, false)
  assert.equal(schedule.view(at(2, 59), options).nextUpdateAt, at(3))
  const due = schedule.view(at(3), options)
  assert.equal(due.updateDue, true); assert.equal(due.updateCheckDue, true)
  schedule.attempted(due.updateDay)
  assert.equal(schedule.view(at(3, 30), options).updateCheckDue, false)
  assert.equal(schedule.view(at(3, 30), options).updateDue, true)
  assert.equal(schedule.view(at(4), options).updateDue, false)
  assert.equal(schedule.view(at(4), options).nextUpdateAt, at(3) + 86400000)
  assert.equal(schedule.view(at(3), { ...options, autoApply: false }).nextUpdateAt, null)
})
test('installation windows spanning midnight retain the starting date', () => {
  const schedule = new UpdateSchedule(at(23))
  const settings = { ...options, updateTimeMinutes: 23 * 60 + 30, updateWindowMinutes: 120 }
  const first = schedule.view(at(23, 45), settings); schedule.attempted(first.updateDay)
  const next = schedule.view(new Date(2026, 9, 4, 0, 15).getTime(), settings)
  assert.equal(next.updateDue, true); assert.equal(next.updateCheckDue, false)
})
