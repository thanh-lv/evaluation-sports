import DeviceCheck
import Foundation

/// `DeviceCheckProviding` on `DCDevice` (unsupported on the Simulator).
struct DeviceCheckService: DeviceCheckProviding {
    func token() async -> String? {
        let device = DCDevice.current
        guard device.isSupported else { return nil }
        do {
            let data = try await device.generateToken()
            return data.base64EncodedString()
        } catch {
            return nil
        }
    }
}
