"use client"
import { useState, useEffect } from "react"
interface WindowSize {
    width: number | undefined
    height: number | undefined
  }
  
  // Custom hook for window size
export default  function useWindowSize() {
    const [windowSize, setWindowSize] = useState<WindowSize>({
      width: undefined,
      height: undefined,
    })
  
    useEffect(() => {
      function handleResize() {
        setWindowSize({
          width: window.innerWidth,
          height: window.innerHeight,
        })
      }
  
      if (typeof window !== 'undefined') {
        handleResize()
        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
      }
    }, [])
  
    return windowSize
  }