const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const app = require('../app.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

/** 持仓页顶部「查看更多指标」里显示哪些：最多选 6 个，本地即时预览，保存才落库。 */
class MetricSettings extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      submitting: false,
      max: 6,
      dividendText: '0.00',
      selectedKeys: [],
      selectedMetrics: [],
      optionalMetrics: []
    }
  }

  onLoad() {
    if (!app.isLogin()) {
      app.toGuide()
      return
    }

    api
      .getMetricSettings()
      .then((res) => {
        this.setData(Object.assign({ loading: false }, res.data))
      })
      .catch(util.onError)
  }

  // 本地即时重算（同步，无请求延迟）
  apply(keys) {
    this.setData(api.previewMetrics(keys))
  }

  toggle(e) {
    if (this.data.submitting) return
    const key = e.currentTarget.dataset.key
    const keys = this.data.selectedKeys.slice()
    const i = keys.indexOf(key)

    if (i > -1) {
      keys.splice(i, 1)
    } else {
      if (keys.length >= this.data.max) {
        wx.showToast({ title: '最多选择 ' + this.data.max + ' 个指标', icon: 'none' })
        return
      }
      keys.push(key)
    }
    this.apply(keys)
  }

  // 恢复默认：只改预览，点「确认保存」才落库
  onReset() {
    if (this.data.submitting) return
    api
      .getDefaultMetricKeys()
      .then((res) => {
        this.apply(res.data)
        wx.showToast({ title: '已恢复默认，记得保存', icon: 'none' })
      })
      .catch(util.onError)
  }

  save() {
    util
      .submit(this, api.saveMetricSettings(this.data.selectedKeys), {
        loadingText: '保存中',
        success: '已保存'
      })
      .then((res) => {
        if (!res) return
        util.backLater(this, 600)
      })
  }

  onUnload() {
    util.cancelBack(this)
  }

  render() {
    if (this.data.loading) {
      return (
        <View style={[s.page, s.center]}>
          <Text style={[s.mid, s.dim]}>加载中…</Text>
        </View>
      )
    }

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          <View style={s.darkCard}>
            <Text style={[s.tiny, s.dimOnDark]}>预测年度分红</Text>
            <Text style={styles.bigNum}>{this.data.dividendText}</Text>
            <Text style={[s.tiny, s.dimOnDark, { marginTop: 10 }]}>
              已选 {this.data.selectedKeys.length} / {this.data.max} 个指标
            </Text>
          </View>

          <View style={[s.between, { marginTop: 22, marginBottom: 10 }]}>
            <Text style={s.h3}>已选指标</Text>
            <Pressable onPress={() => this.onReset()}>
              <Text style={[s.small, { color: colors.primary }]}>恢复默认</Text>
            </Pressable>
          </View>

          <View style={styles.chipWrap}>
            {this.data.selectedMetrics.map((m) => (
              <Pressable
                key={m.key}
                style={[styles.chip, styles.chipOn]}
                onPress={() => this.toggle(tap({ key: m.key }))}
              >
                <Text style={[s.small, styles.chipTextOn]}>{m.name}</Text>
                <Text style={[s.small, styles.chipTextOn, { marginLeft: 6 }]}>✓</Text>
              </Pressable>
            ))}
            {!this.data.selectedMetrics.length ? (
              <Text style={[s.small, s.dim]}>还没选指标，从下面挑几个</Text>
            ) : null}
          </View>

          <Text style={[s.h3, { marginTop: 24, marginBottom: 10 }]}>可选指标</Text>
          <View style={styles.chipWrap}>
            {this.data.optionalMetrics.map((m) => (
              <Pressable key={m.key} style={styles.chip} onPress={() => this.toggle(tap({ key: m.key }))}>
                <Text style={[s.small, { color: colors.t2 }]}>{m.name}</Text>
                {m.desc ? <Text style={[s.tiny, s.dim, { marginLeft: 6 }]}>{m.desc}</Text> : null}
              </Pressable>
            ))}
          </View>

          <Text style={[s.tiny, s.dim, { marginTop: 18, lineHeight: 18 }]}>
            这些指标会显示在持仓页顶部「查看更多指标」里；选 0 个则整块汇总收起。
          </Text>
        </ScrollView>

        <View style={styles.bottomBar}>
          <Pressable style={[s.btn, s.flex1]} onPress={() => this.save()}>
            <Text style={s.btnText}>确认保存</Text>
          </Pressable>
        </View>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  bigNum: { marginTop: 8, fontSize: 30, fontWeight: '700', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    marginRight: 10,
    marginBottom: 10
  },
  chipOn: { backgroundColor: colors.primarySoft },
  chipTextOn: { color: colors.primary, fontWeight: '600' },
  bottomBar: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: '#FFFFFF'
  }
})

module.exports = MetricSettings
