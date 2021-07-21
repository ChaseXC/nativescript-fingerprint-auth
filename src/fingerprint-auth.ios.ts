import { iOSNativeHelper as iOSUtils } from '@nativescript/core/utils';
import {
  BiometricIDAvailableResult,
  FingerprintAuthApi,
  VerifyFingerprintOptions,
  VerifyFingerprintWithCustomFallbackOptions,
  ERROR_CODES
} from "./fingerprint-auth.common";

const keychainItemIdentifier = "TouchIDKey";
let keychainItemServiceName = null;

export class FingerprintAuth implements FingerprintAuthApi {
  private laContext: LAContext;

  available(): Promise<BiometricIDAvailableResult> {
    return new Promise((resolve, reject) => {
      /* Describing laContext.biometryType:
         This property is set only after you call the
         canEvaluatePolicy(_:error:) method, and is set no matter what the call returns.
         The default value is LABiometryType.none.
      */
      const laContext = LAContext.new();
      let biometryConfigured = true;
      try {
        biometryConfigured = laContext.canEvaluatePolicyError(LAPolicy.DeviceOwnerAuthenticationWithBiometrics);
      } catch (ex) {
        // LAError.BiometryNotEnrolled
        if (ex.error != null && ex.error.code != null && ex.error.code === -7) {
          biometryConfigured = false;
        }
        console.log(`fingerprint-auth.available: ${ex}`);
      } finally {
        const hasTouch = laContext.biometryType === 1; // LABiometryType.TypeTouchID,
        const hasFace = laContext.biometryType === 2; // LABiometryType.TypeFaceID,
        resolve({
          any: hasFace || hasTouch,
          touch: {
            supported: hasTouch,
            configured: hasTouch && biometryConfigured
          },
          face: {
            supported: hasFace,
            configured: hasFace && biometryConfigured
          }
        });
      }
    });
  }

  didFingerprintDatabaseChange(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const laContext = LAContext.new();

        // we expect the dev to have checked 'isAvailable' already so this should not return an error,
        // we do however need to run canEvaluatePolicy here in order to get a non-nil evaluatedPolicyDomainState
        if (!laContext.canEvaluatePolicyError(LAPolicy.DeviceOwnerAuthenticationWithBiometrics)) {
          reject({
            code: ERROR_CODES.NOT_AVAILABLE,
            message: `Biometry not available. Call 'available' first.`
          });
          return;
        }

        // only supported on iOS9+, so check this.. if not supported just report back as false
        if (iOSUtils.MajorVersion < 9) {
          resolve(false);
          return;
        }

        const FingerprintDatabaseStateKey = "FingerprintDatabaseStateKey";
        const state = laContext.evaluatedPolicyDomainState;
        if (state !== null) {
          const stateStr = state.base64EncodedStringWithOptions(0);
          const storedState = NSUserDefaults.standardUserDefaults.stringForKey(FingerprintDatabaseStateKey);

          // Store enrollment
          NSUserDefaults.standardUserDefaults.setObjectForKey(stateStr, FingerprintDatabaseStateKey);
          NSUserDefaults.standardUserDefaults.synchronize();

          // whenever a finger is added/changed/removed the value of the storedState changes,
          // so compare agains a value we previously stored in the context of this app
          const changed = storedState !== null && stateStr !== storedState;
          resolve(changed);
        }
      } catch (ex) {
        console.log(`Error in fingerprint-auth.didFingerprintDatabaseChange: ${ex}`);
        resolve(false);
      }
    });
  }

  /**
   * this 'default' method uses keychain instead of localauth so the passcode fallback can be used
   */
  verifyFingerprint(options: VerifyFingerprintOptions): Promise<void | string> {
    return new Promise((resolve, reject) => {
      try {
        if (keychainItemServiceName === null) {
          const bundleID = NSBundle.mainBundle.infoDictionary.objectForKey("CFBundleIdentifier");
          keychainItemServiceName = `${bundleID}.TouchID`;
        }

        if (!FingerprintAuth.createKeyChainEntry()) {
          this.verifyFingerprintWithCustomFallback(options, true).then(
              resolve,
              reject
          );
          return;
        }

        const query = NSMutableDictionary.alloc().init();
        query.setObjectForKey(kSecClassGenericPassword, kSecClass);
        query.setObjectForKey(keychainItemIdentifier, kSecAttrAccount);
        query.setObjectForKey(keychainItemServiceName, kSecAttrService);

        // Note that you can only do this for Touch ID; for Face ID you need to tweak the plist value of NSFaceIDUsageDescription
        query.setObjectForKey(
            (options !== null && options.message) || "Scan your finger",
            kSecUseOperationPrompt
        );

        // Start the query and the fingerprint scan and/or device passcode validation
        const res = SecItemCopyMatching(query, null);
        if (res === 0) {
          resolve();
        } else {
          reject({
            code: ERROR_CODES.UNEXPECTED_ERROR,
            message: `Encountered unexpected error with SecItemCopyMatching`
          });
        }
      } catch (ex) {
        console.log(`Error in fingerprint-auth.verifyFingerprint: ${ex}`);
        reject(ex);
      }
    });
  }

  /**
   * This implementation uses LocalAuthentication and has no built-in passcode fallback
   */
  verifyFingerprintWithCustomFallback(
      options: VerifyFingerprintWithCustomFallbackOptions,
      usePasscodeFallback = false
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.laContext = LAContext.new();
        try {
        if (!this.laContext.canEvaluatePolicyError(LAPolicy.DeviceOwnerAuthenticationWithBiometrics)) {
          reject({
            code: ERROR_CODES.NOT_AVAILABLE,
            message: `Biometry not available. Call 'available' first.`
          });
          return;
        }
      } catch (ex) {
        if (ex.error != null && ex.error.code != null) {
          if (ex.error.code === -8) {
            // Need to use LAPolicy.DeviceOwnerAuthentication in this case
            usePasscodeFallback = true;
          } else if (ex.error.code === -7) {
            reject({
              code: ERROR_CODES.NOT_CONFIGURED,
              message: "No biometric authentication has been configured.",
            });
            return;
          } else if (ex.error.code === -6) {
            reject({
              code: ERROR_CODES.NOT_AVAILABLE,
              message: "Biometry not available. Call 'available' first.",
            });
            return;
          }
        }
      }

        const message = (options !== null && options.message) || "Scan your finger";
        if (options !== null && options.fallbackMessage) {
          this.laContext.localizedFallbackTitle = options.fallbackMessage;
        }
        this.laContext.evaluatePolicyLocalizedReasonReply(
            usePasscodeFallback ? LAPolicy.DeviceOwnerAuthentication : LAPolicy.DeviceOwnerAuthenticationWithBiometrics,
            message,
            (ok, error) => {
              if (ok) {
                resolve();
              } else {
                reject({
                  code: error.code,
                  message: error.localizedDescription
                });
              }
            }
        );
      } catch (ex) {
        console.log(`Error in fingerprint-auth.verifyFingerprint: ${ex}`);
        reject(ex);
      }
    });
  }

  private static createKeyChainEntry(): boolean {
    const attributes = NSMutableDictionary.new();
    attributes.setObjectForKey(kSecClassGenericPassword, kSecClass);
    attributes.setObjectForKey(keychainItemIdentifier, kSecAttrAccount);
    attributes.setObjectForKey(keychainItemServiceName, kSecAttrService);

    const accessControlRef = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        2, // either SecAccessControlCreateFlags.kSecAccessControlBiometryAny (iOS 11.3+), or SecAccessControlCreateFlags.kSecAccessControlTouchIDAny (iOS < 11.3)
        null
    );
    if (accessControlRef === null) {
      console.log(`Can't store identifier '${keychainItemIdentifier}' in the KeyChain.`);
      return false;
    } else {
      attributes.setObjectForKey(accessControlRef, kSecAttrAccessControl);
      // The content of the password is not important
      const content = NSString.stringWithString("dummy content");
      const nsData = content.dataUsingEncoding(NSUTF8StringEncoding);
      attributes.setObjectForKey(nsData, kSecValueData);

      SecItemAdd(attributes, null);
      return true;
    }
  }

  close(): void {
    if (this.laContext) {
      this.laContext.invalidate();
    }
  }
}
