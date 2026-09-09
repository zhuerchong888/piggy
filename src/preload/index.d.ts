import type { PiggyApi } from '../shared/contracts'

declare global {
  interface Window {
    piggy: PiggyApi
  }
}

export {}
