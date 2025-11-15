// app/actions/config.ts
"use server"

import { prisma } from '@/lib/prisma'
import { cookies } from 'next/headers'

// Custom error class for better error handling
class AdminActionError extends Error {
  constructor(message: string, public code?: string) {
    super(message)
    this.name = 'AdminActionError'
  }
}

// Error handler wrapper
async function withErrorHandling<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    console.error(`❌ [${operationName}] Error:`, error)
    
    // Handle different types of errors
    if (error instanceof AdminActionError) {
      throw error
    }
    
    // Prisma specific errors
    if (error && typeof error === 'object' && 'code' in error) {
      const prismaError = error as any
      switch (prismaError.code) {
        case 'P2002':
          throw new AdminActionError('Давхардсан утга оруулж болохгүй', 'DUPLICATE_ERROR')
        case 'P2025':
          throw new AdminActionError('Өгөгдөл олдсонгүй', 'NOT_FOUND')
        case 'P1001':
          throw new AdminActionError('Өгөгдлийн санд холбогдож чадсангүй', 'CONNECTION_ERROR')
        default:
          throw new AdminActionError(`Өгөгдлийн сангийн алдаа: ${prismaError.message || 'Тодорхойгүй алдаа'}`, 'DATABASE_ERROR')
      }
    }
    
    // Network or other errors
    if (error instanceof Error) {
      throw new AdminActionError(`Систем алдаа: ${error.message}`, 'SYSTEM_ERROR')
    }
    
    // Unknown errors
    throw new AdminActionError('Тодорхойгүй алдаа гарлаа', 'UNKNOWN_ERROR')
  }
}

// Simple authentication
export async function authenticateAdmin(formData: FormData) {
  return withErrorHandling(async () => {
    const username = formData.get('username') as string
    const password = formData.get('password') as string
    
    if (username === 'admin' && password === 'admin123') {
      const cookieStore = await cookies()
      cookieStore.set('admin-auth', 'authenticated', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60 * 24 // 24 hours
      })
      return { success: true }
    } else {
      throw new AdminActionError('Буруу нэвтрэх мэдээлэл', 'INVALID_CREDENTIALS')
    }
  }, 'authenticateAdmin')
}

export async function logout() {
  return withErrorHandling(async () => {
    const cookieStore = await cookies()
    cookieStore.delete('admin-auth')
    // Do not call redirect here; handle redirect on client
    return { success: true }
  }, 'logout')
}

export async function isAuthenticated() {
  return withErrorHandling(async () => {
    const cookieStore = await cookies()
    const authCookie = cookieStore.get('admin-auth')
    return authCookie?.value === 'authenticated'
  }, 'isAuthenticated')
}

// Site Config Actions (keep if you use site config)
export async function getSiteConfig() {
  return withErrorHandling(async () => {
    const config = await prisma.siteConfig.findFirst()
    if (!config) {
      // Fallback to static site config
      const { siteConfig } = await import('@/config/site')
      return siteConfig;
    }
    return config;
  }, 'getSiteConfig')
}

export async function updateSiteConfig(data: any) {
  return withErrorHandling(async () => {
    if (!data.name || !data.description) {
      throw new AdminActionError('Нэр болон тайлбар заавал шаардлагатай', 'VALIDATION_ERROR')
    }
    const existing = await prisma.siteConfig.findFirst()
    let result
    if (existing) {
      result = await prisma.siteConfig.update({
        where: { id: existing.id },
        data
      })
    } else {
      result = await prisma.siteConfig.create({ data })
    }
    return result
  }, 'updateSiteConfig')
}

  