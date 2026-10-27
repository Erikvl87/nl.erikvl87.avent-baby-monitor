import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function Disclaimer() {
  return (
    <div className={styles.disclaimer}>
      <div className="container">
        <strong>Disclaimer:</strong> This is an independent, community-developed app and is not affiliated with, endorsed by, or connected to Philips or Philips Avent. "Philips" and "Avent" are trademarks of their respective owners.
      </div>
    </div>
  );
}

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <div className={styles.heroWrapper}>
          <div className={styles.heroContent}>
            <img
              className={styles.heroImage}
              src={useBaseUrl('/img/logo.png')}
              alt=""
            />
            <Heading as="h1" className="hero__title">
              {siteConfig.title}
            </Heading>
            <p className="hero__subtitle">{siteConfig.tagline}</p>
            <p className={styles.heroDescription}>
              <strong>Philips Avent Baby Monitor</strong> is a <a href="https://homey.app/">Homey</a> app for the Philips Avent connected baby monitors that you set up with the Philips Avent Baby Monitor+ app. It shows the nursery temperature, raises motion and sound alarms, and lets your flows control the night light, the lullabies and the camera's privacy mode. You can watch the live camera in Homey, and on SenseIQ models the app also shows whether your baby is in the crib, the breathing rate and crying.
            </p>
            <div className={styles.buttons}>
              <Link
                className="button button--secondary button--lg"
                to="/docs/getting-started">
                Get Started
              </Link>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} Documentation`}
      description="Use your Philips Avent connected baby monitor with Homey: temperature, motion and sound alarms, night light, lullabies, privacy mode and live video.">
      <Disclaimer />
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
