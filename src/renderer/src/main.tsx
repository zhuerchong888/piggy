import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

const requestedSurface = new URLSearchParams(window.location.search).get('surface')
document.documentElement.dataset.surface = requestedSurface === 'bubble' || requestedSurface === 'popup' ? requestedSurface : 'main'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
