declare module 'claude-code' {
  interface PluginState {
    'el-fogonero': {
      brasa: { tokens: number; ultimoTurno: number; modelo: string }
      ajustes: { ttlMin: number; freno: boolean }
    }
  }
}
