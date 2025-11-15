"use client"

import { useState } from "react"
import Link from "next/link"
import {
  Home,
  Menu,
} from "lucide-react"

import { siteConfig } from "@/config/site"
import { Button } from "@/components/ui/button"
import {
  NavigationMenu,
  NavigationMenuLink,
  NavigationMenuList,
} from "@/components/ui/navigation-menu"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

const navigation = [
  { href: "/courses", text: "Сургалтууд" },
  { href: "/contact", text: "Холбоо барих" },
]

export function Header() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <header className="sticky top-0 w-full  z-50">
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between">
          {/* Logo */}
          <Link
            href="/"
            className="flex items-center space-x-2"
            onClick={() => setIsOpen(false)}
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center">
              <Home className="w-5 h-5" />
            </div>
            <span className="text-xl font-semibold">{siteConfig.name}</span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center space-x-8">
            <NavigationMenu>
              <NavigationMenuList className="flex space-x-8">
                {navigation.map((link, index) => (
                  <NavigationMenuLink key={index} asChild>
                    <Link 
                      href={link.href} 
                      className="hover:transition-colors px-3 py-2 text-sm font-medium"
                    >
                      {link.text}
                    </Link>
                  </NavigationMenuLink>
                ))}
              </NavigationMenuList>
            </NavigationMenu>
            
        
          </div>

          {/* Mobile Menu */}
          <Sheet open={isOpen} onOpenChange={setIsOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Toggle menu"
              >
                <Menu className="w-6 h-6" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[300px] sm:w-[400px]">
              <SheetHeader>
                <SheetTitle>
                  <Link
                    href="/"
                    className="flex items-center space-x-2"
                    onClick={() => setIsOpen(false)}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center">
                      <Home className="w-5 h-5" />
                    </div>
                    <span className="text-xl font-semibold">{siteConfig.name}</span>
                  </Link>
                </SheetTitle>
              </SheetHeader>
              
              <div className="flex flex-col space-y-4 mt-8">
                {navigation.map((link, index) => (
                  <Link
                    key={index}
                    href={link.href}
                    className="hover:transition-colors py-2 text-lg font-medium border-b border-border last:border-b-0"
                    onClick={() => setIsOpen(false)}
                  >
                    {link.text}
                  </Link>
                ))}
                
              
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
