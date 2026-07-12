import MainLayout from "./components/MainLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import WebAuthGate from "./components/WebAuthGate";

function App() {
  return (
    <ErrorBoundary>
      <WebAuthGate>
        <MainLayout />
      </WebAuthGate>
    </ErrorBoundary>
  );
}

export default App;
