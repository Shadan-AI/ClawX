/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'shake': {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '10%': { transform: 'translate(calc(-1.5px * var(--shake-intensity, 1)), calc(-1px * var(--shake-intensity, 1)))' },
          '20%': { transform: 'translate(calc(1.5px * var(--shake-intensity, 1)), calc(1px * var(--shake-intensity, 1)))' },
          '30%': { transform: 'translate(calc(-1.5px * var(--shake-intensity, 1)), calc(1px * var(--shake-intensity, 1)))' },
          '40%': { transform: 'translate(calc(1.5px * var(--shake-intensity, 1)), calc(-1px * var(--shake-intensity, 1)))' },
          '50%': { transform: 'translate(calc(-1px * var(--shake-intensity, 1)), calc(1.5px * var(--shake-intensity, 1)))' },
          '60%': { transform: 'translate(calc(1px * var(--shake-intensity, 1)), calc(-1.5px * var(--shake-intensity, 1)))' },
          '70%': { transform: 'translate(calc(-1px * var(--shake-intensity, 1)), calc(-1px * var(--shake-intensity, 1)))' },
          '80%': { transform: 'translate(calc(1px * var(--shake-intensity, 1)), calc(1px * var(--shake-intensity, 1)))' },
          '90%': { transform: 'translate(calc(-0.5px * var(--shake-intensity, 1)), 0)' },
        },
        'particle': {
          '0%': { 
            transform: 'translateY(0) scale(1)',
            opacity: '1',
          },
          '100%': { 
            transform: 'translateY(-40px) scale(0)',
            opacity: '0',
          },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
