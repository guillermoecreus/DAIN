export class EventEmitter {
  constructor() { this.handlers = new Map(); }
  setMaxListeners() {}
  on(name, fn) { (this.handlers.get(name) || this.handlers.set(name, []).get(name)).push(fn); return this; }
  emit(name, ...args) { for (const fn of this.handlers.get(name) || []) fn(...args); return true; }
}
