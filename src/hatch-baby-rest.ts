/**
 * If you are viewing this code and considering extracting it for another use,
 * please let me know with a GitHub issue!  I would be happy to provide an API that
 * can be used by other projects, but didn't want to go to the work until there was a need.
 */

import { BehaviorSubject, fromEvent, Subscription } from 'rxjs'
import {
  debounceTime,
  distinctUntilChanged,
  filter,
  map,
  share,
  skip,
  startWith,
  take
} from 'rxjs/operators'
import { kebabCaseAddress, stripUuid } from './util'
import {
  AudioTrack,
  Color,
  formatRestCommand,
  RestCommand,
  RestCommandValue
} from './rest-commands'
import { Peripheral, Service } from 'noble'
import { promisify } from 'util'
import { colorsMatch, Feedback, parseFeedbackBuffer } from './feedback'
import { HAP } from './hap'

const noble = require('@abandonware/noble')

const enum ServiceUuid {
  Advertising = '02260001-5efd-47eb-9c1a-de53f7a2b232',
  Rest = '02240001-5efd-47eb-9c1a-de53f7a2b232'
}

const enum CharacteristicUuid {
  Tx = '02240002-5efd-47eb-9c1a-de53f7a2b232',
  Rx = '02240003-5efd-47eb-9c1a-de53f7a2b232',
  CurrentFeedback = '02260002-5efd-47eb-9c1a-de53f7a2b232'
}

export class HatchBabyRest {
  address = kebabCaseAddress(this.macAddress)
  peripheralPromise = this.getPeripheralByAddress(this.address)

  onFeedback = new BehaviorSubject<Feedback>({
    time: 0,
    power: false,
    volume: 0,
    color: { r: 0, g: 0, b: 0, a: 0 },
    audioTrack: AudioTrack.None
  })
  onPower = this.onFeedback.pipe(
    map(feedback => feedback.power),
    distinctUntilChanged(),
    share()
  )
  onVolume = this.onFeedback.pipe(
    map(feedback => feedback.volume),
    distinctUntilChanged(),
    share()
  )
  onColor = this.onFeedback.pipe(
    map(feedback => feedback.color),
    distinctUntilChanged(colorsMatch),
    share()
  )
  onAudioTrack = this.onFeedback.pipe(
    map(feedback => feedback.audioTrack),
    distinctUntilChanged(),
    share()
  )

  reconnectSubscription?: Subscription

  constructor(
    private name: string,
    private macAddress: string,
    private logger: HAP.Log
  ) {
    this.getDevice().then(device => {
      device.on('connect', () => {
        return this.subscribeToFeedback()
      })
    })

    process.on('SIGINT', () => {
      this.disconnect()
    })
  }

  async getPeripheralByAddress(address: string) {
    await fromEvent(noble, 'stateChange')
      .pipe(
        startWith(noble.state),
        filter(state => state === 'poweredOn'),
        take(1)
      )
      .toPromise()

    const peripheralPromise = fromEvent<Peripheral>(noble, 'discover')
      .pipe(
        filter(peripheral => peripheral.address === address),
        take(1)
      )
      .toPromise()

    this.logger.info('Scanning for ' + this.name)
    noble.startScanning(['180a'])

    return peripheralPromise
  }

  async connect() {
    const device = await this.getDevice()

    if (device.state === 'connected') {
      return device
    }

    await promisify(device.connect.bind(device) as any)()
    this.logger.info('Connected to ' + this.name)
    return device
  }

  disconnect() {
    if (this.reconnectSubscription) {
      this.reconnectSubscription.unsubscribe()
      this.reconnectSubscription = undefined
    }

    if (this.device) {
      this.device.disconnect()
    }
    this.logger.info('Disconnected from ' + this.name)
  }

  reconnect() {
    this.logger.info('Reconnecting to ' + this.name)
    this.discoverServicesPromise = undefined
    this.disconnect()
    this.connect()
  }

  discoverServicesPromise?: Promise<Service[]>
  getServices() {
    if (!this.discoverServicesPromise) {
      this.discoverServicesPromise = this.connect().then(device =>
        promisify(device.discoverAllServicesAndCharacteristics.bind(
          device
        ) as any)()
      )
    }

    return this.discoverServicesPromise
  }

  async getService(serviceUuid: string) {
    const services = await this.getServices()
    return services.find(service => service.uuid === stripUuid(serviceUuid))!
  }

  async getCharacteristic(characteristicUuid: string, serviceUuid: string) {
    const service = await this.getService(serviceUuid)
    return service.characteristics.find(characteristic =>
      stripUuid(characteristic.uuid)
    )!
  }

  private device?: Peripheral
  async getDevice() {
    if (this.device) {
      return this.device
    }

    return (this.device = await this.peripheralPromise)
  }

  async getName() {
    const device = await this.getDevice()
    return device.advertisement.localName
  }

  async setCommand(command: RestCommand, value: RestCommandValue) {
    const writeCharacteristic = await this.getCharacteristic(
        CharacteristicUuid.Tx,
        ServiceUuid.Rest
      ),
      restCommand = formatRestCommand(command, value)

    await promisify(writeCharacteristic.write.bind(writeCharacteristic) as any)(
      restCommand,
      false
    )
  }

  setAudioTrack(track: AudioTrack) {
    return this.setCommand(RestCommand.SetTrackNumber, track)
  }

  setColor(color: Color) {
    return this.setCommand(RestCommand.SetColor, color)
  }

  setVolume(volume: number) {
    if (volume < 0 || volume > 100) {
      throw new Error('Volume must be between 0 and 100.  Received ' + volume)
    }

    return this.setCommand(
      RestCommand.SetVolume,
      Math.floor((volume / 100) * 255)
    )
  }

  setPower(on: boolean) {
    return this.setCommand(RestCommand.SetPower, on ? 1 : 0)
  }

  async subscribeToFeedback() {
    const feedbackCharacteristic = await this.getCharacteristic(
      CharacteristicUuid.CurrentFeedback,
      ServiceUuid.Advertising
    )

    feedbackCharacteristic.on('read', (data: Buffer) => {
      this.onFeedback.next(parseFeedbackBuffer(data))
    })

    feedbackCharacteristic.subscribe(err => {
      if (err) {
        this.logger.error('Failed to subscribe to feedback events', err)
      }
    })

    this.reconnectSubscription = this.onFeedback
      .pipe(
        skip(1),
        debounceTime(5000)
      )
      .subscribe(() => this.reconnect())
  }

  get currentFeedback() {
    this.connect()
    return this.onFeedback.getValue()
  }
}