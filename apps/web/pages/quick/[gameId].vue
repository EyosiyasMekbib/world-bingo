<template>
  <div class="game-room">
    <div v-if="game" class="header">
      <h2>{{ game.title }}</h2>
      <div class="status">Status: {{ game.status }}</div>
      <div v-if="lastCalledBall" class="last-called">
         Called Ball: {{ lastCalledBall }}
      </div>
    </div>
    
    <div v-if="hasJoined" class="play-area">
       <!-- Game Grid -->
       <div class="cartelas-list">
          <div v-for="entry in myEntries" :key="entry.id" class="my-cartela">
             <h4>Ref: {{ entry.cartela.serial }}</h4>
             <div class="grid">
                 <div v-for="(row, r) in getGrid(entry.cartela.grid)" :key="r" class="row">
                     <div v-for="(num, c) in row" :key="c" 
                          class="cell" 
                          :class="{ marked: isMarked(num), center: r===2 && c===2 }"
                          @click="markCell(entry.cartela.id, r, c)">
                        {{ num === 0 ? '★' : num }}
                     </div>
                 </div>
             </div>
             <button @click="claimBingo(entry.cartela.id)" class="bingo-btn">BINGO!</button>
          </div>
       </div>
    </div>
    
    <div v-else class="join-area">
       <h3>Select a Card to Join</h3>
       <div class="available-cartelas">
           <div v-for="cartela in availableCartelas" :key="cartela.id" 
                class="cartela-preview" 
                :class="{ selected: selectedCartelaId === cartela.id }"
                @click="selectedCartelaId = cartela.id">
                #{{ cartela.serial }}
           </div>
       </div>
       <button @click="joinGame" :disabled="!selectedCartelaId" class="join-btn">
          Pay {{ game?.ticketPrice }} ETB & Join
       </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Game, Cartela } from '@world-bingo/shared-types'

const route = useRoute()
const gameId = route.params.gameId as string
const config = useRuntimeConfig()
const auth = useAuth()
const { socket, connect } = useSocket()

const game = ref<Game | null>(null)
const availableCartelas = ref<Cartela[]>([])
const selectedCartelaId = ref<string | null>(null)
const myEntries = ref<any[]>([])
const calledBalls = ref<number[]>([])

const hasJoined = computed(() => myEntries.value.length > 0)
const lastCalledBall = computed(() => calledBalls.value[calledBalls.value.length - 1])

// Fetch initial game state
const { data: initialGame } = await useFetch<Game>(`${config.public.apiBase}/games/${gameId}`)
if (initialGame.value) {
    game.value = initialGame.value
    calledBalls.value = initialGame.value.calledBalls || []
    
    // Check if I am already in
    // Note: The API 'get game' includes entries? yes
    // But we need to filter for ME.
    // initialGame.value.entries (needs to be typed properly in frontend if we want TS support)
    // For now we assume we fetch "my status" separately or filter.
}

// Fetch availables
const { data: cartelas } = await useFetch<any[]>(`${config.public.apiBase}/games/${gameId}/cartelas`)
availableCartelas.value = cartelas.value?.filter(c => !c.isTaken) || []

onMounted(() => {
    const s = connect()
    if (!s) return
    
    s.emit('game:join-room', { gameId }) // Client logic needs to emit this? Gateway expected `game:join` (pay & join). Need just room sub.
    // My Gateway `registerGameHandlers` expects `game:join` to mean PAY and ENTER.
    // I missed a "watch" or "enter lobby" event. 
    // BUT the gateway does: `socket.join(game:${gameId})` AFTER join success.
    // So usually observers can't see the game events unless they join?
    // Spec says "Lobby fetches available games... New game sessions are surfaced".
    // "Live Game Screen" ... "Previousy called numbers check..."
    // Ideally we join the socket room to get updates even if not playing?
    // For now, let's assume `game:join` triggers the PAYMENT.
    // I should add a way to just "watch" or "enter room updates".
    // I will use `game:join` only for paying.
    // How do I get updates? I need to emit an event to join the socket room without paying.
    // `socket.join` is server side.
    // I'll add `game:enter-room` to backend later. 
    
    s.on('game:updated', (updatedGame) => {
        game.value = updatedGame
    })
    
    s.on('game:ball-called', ({ ball, calledBalls: newCalledBalls }) => {
        calledBalls.value = newCalledBalls
    })
    
    s.on('game:winner', ({ winner, prizeAmount }) => {
        alert(`${winner.username} WON ${prizeAmount} ETB!`)
    })
})

function getGrid(jsonGrid: any) {
    return typeof jsonGrid === 'string' ? JSON.parse(jsonGrid) : jsonGrid
}

function isMarked(num: number) {
    if (num === 0) return true
    return calledBalls.value.includes(num)
}

async function joinGame() {
    if (!selectedCartelaId.value) return
    const s = connect()
    s?.emit('game:join', { gameId, cartelaId: selectedCartelaId.value })
    // Optimistic UI or wait for response?
    // Socket emits 'error' on fail.
    // I need to listen for success or fetch game again.
    // Let's manually refetch game entries after short delay or listen to 'game:updated' to see if we are in.
}

function claimBingo(cartelaId: string) {
    const s = connect()
    s?.emit('game:claim-bingo', { gameId, cartelaId })
}

function markCell(cartelaId: string, row: number, col: number) {
    // Client side visual only, or server?
    // Spec says "Auto-marked cards".
    // Client just highlights.
}

</script>

<style scoped>
.game-room { padding: 1rem; }
.header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #333; padding-bottom: 1rem;}
.last-called { font-size: 2rem; color: var(--color-primary); font-weight: bold; }

.play-area { margin-top: 2rem; }
.cartelas-list { display: flex; flex-wrap: wrap; gap: 2rem; justify-content: center; }
.my-cartela { background: #222; padding: 1rem; border-radius: 8px; }

.grid { display: grid; grid-template-rows: repeat(5, 1fr); gap: 4px; margin: 1rem 0; }
.row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
.cell { 
    width: 40px; height: 40px; 
    display: flex; align-items: center; justify-content: center;
    background: #333; border-radius: 4px; cursor: pointer;
    font-weight: bold;
}
.cell.marked { background: var(--color-primary); color: #000; }
.cell.center { background: #555; }

.available-cartelas { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0; }
.cartela-preview { padding: 0.5rem; border: 1px solid #444; cursor: pointer; }
.cartela-preview.selected { border-color: var(--color-primary); background: #333; }
.join-btn { padding: 1rem 2rem; font-size: 1.2rem; background: var(--color-primary); color: white; border: none; border-radius: 8px; cursor: pointer; }
.bingo-btn { width: 100%; padding: 1rem; background: red; color: white; font-weight: bold; border: none; border-radius: 4px; cursor: pointer; margin-top: 1rem; }
</style>
