export function readBoardState(state) {
  return state.persistence.readBoardState()
}

export function writeBoardState(state, patch) {
  state.persistence.writeBoardState(patch)
}
