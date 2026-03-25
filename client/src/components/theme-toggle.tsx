import { Sun, Moon } from 'lucide-react';
import { useAppStore } from '@/store';

export function ThemeToggle() {
  const theme = useAppStore(state => state.theme);
  const toggleTheme = useAppStore(state => state.toggleTheme);

  return (
    <button 
      onClick={toggleTheme}
      className="p-2.5 rounded-full bg-card shadow-sm border border-border/50 hover:bg-accent/50 text-foreground transition-all active:scale-95 flex-shrink-0"
      aria-label="Toggle Theme"
    >
      {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  );
}
