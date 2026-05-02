import { Outlet } from 'react-router-dom'
import { motion } from 'framer-motion'

export function KioskLayout() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 to-purple-900 flex items-center justify-center">
      <div className="w-full max-w-md">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white rounded-2xl shadow-2xl overflow-hidden"
        >
          <div className="h-2 bg-gradient-to-r from-indigo-500 to-purple-500" />
          <div className="p-8">
            <div className="flex justify-center mb-6">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                  <span className="text-white font-bold text-sm">N</span>
                </div>
                <span className="font-bold text-gray-900">NexusRH</span>
                <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                  Kiosk
                </span>
              </div>
            </div>
            <Outlet />
          </div>
        </motion.div>
      </div>
    </div>
  )
}
