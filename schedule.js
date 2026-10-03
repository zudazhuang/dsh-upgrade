/** Wall-clock scheduling uses the computer's local time and catches up after sleep. */
export class UpdateSchedule {
  /** @param {number} now Startup timestamp. */
  constructor(now) { this.checkedAt = now; this.updateDay = null }
  /** Record every completed or failed check to avoid retrying errors every second.
   * @param {number} now Completion timestamp.
   */
  checked(now) { this.checkedAt = now }
  /** Read due work and visible next timestamps from current settings.
   * @param {number} now Current timestamp.
   * @param {object} options Current scheduling settings.
   * @returns {object} Check deadline, daily window and due flags.
   */
  view(now, options) {
    const nextCheckAt = options.scheduledChecks ? this.checkedAt + options.checkIntervalMinutes * 60000 : null
    const start = new Date(now)
    start.setHours(Math.floor(options.updateTimeMinutes / 60), options.updateTimeMinutes % 60, 0, 0)
    if (start.getTime() > now) start.setDate(start.getDate() - 1)
    const end = start.getTime() + options.updateWindowMinutes * 60000
    const inWindow = now < end
    const next = new Date(start)
    if (!inWindow) next.setDate(next.getDate() + 1)
    const day = `${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`
    return {
      nextCheckAt, nextUpdateAt: options.autoApply ? Math.max(now, next.getTime()) : null,
      checkDue: nextCheckAt !== null && now >= nextCheckAt,
      updateDue: options.autoApply && inWindow,
      updateCheckDue: options.autoApply && inWindow && this.updateDay !== day,
      updateDay: day,
    }
  }
  /** Prevent repeated release requests within one daily installation window.
   * @param {string} day Local date key returned by view.
   */
  attempted(day) { this.updateDay = day }
}
