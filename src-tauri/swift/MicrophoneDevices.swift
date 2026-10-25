import AVFoundation
import AudioToolbox
import CoreAudio

enum MicrophoneDevices {
    private static func property(_ selector: AudioObjectPropertySelector,
                                 scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func string(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = property(selector)
        var result: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &result) == noErr else { return nil }
        return result as String
    }

    private static func defaultDevice() -> AudioDeviceID {
        var address = property(kAudioHardwarePropertyDefaultInputDevice)
        var result = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &result)
        return result
    }

    private static func inputDevices() -> [AudioDeviceID] {
        var address = property(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        let status = devices.withUnsafeMutableBytes { buffer in
            AudioObjectGetPropertyData(system, &address, 0, nil, &size, buffer.baseAddress!)
        }
        guard status == noErr else { return [] }
        return devices.filter { device in
            var streams = property(kAudioDevicePropertyStreams, scope: kAudioDevicePropertyScopeInput)
            var bytes: UInt32 = 0
            return AudioObjectGetPropertyDataSize(device, &streams, 0, nil, &bytes) == noErr && bytes > 0
        }
    }

    static func list() -> [[String: Any]] {
        let selected = defaultDevice()
        return inputDevices().compactMap { device in
            guard let id = string(device, kAudioDevicePropertyDeviceUID),
                  let name = string(device, kAudioObjectPropertyName) else { return nil }
            return ["id": id, "name": name, "isDefault": device == selected]
        }
    }

    static func configure(engine: AVAudioEngine, uid: String) throws {
        let device: AudioDeviceID?
        if uid.isEmpty { device = defaultDevice() }
        else { device = inputDevices().first { string($0, kAudioDevicePropertyDeviceUID) == uid } }
        guard var device, device != kAudioObjectUnknown,
              let audioUnit = engine.inputNode.audioUnit else {
            throw NSError(domain: "Transrator", code: 3, userInfo: [NSLocalizedDescriptionKey: "선택한 마이크가 연결되어 있는지 확인해주세요."])
        }
        let status = AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard status == noErr else {
            throw NSError(domain: "Transrator", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "선택한 마이크를 사용할 수 없습니다. 다른 마이크를 선택해주세요."])
        }
    }
}

@_cdecl("dictation_list_microphones")
public func dictation_list_microphones() -> UnsafeMutablePointer<CChar>? {
    jsonCString(MicrophoneDevices.list())
}
